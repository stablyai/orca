import { joinPreservingTrailingNewline, withCrLine, withTrailingCr } from './config-toml-line-scan'
import {
  normalizeCodexRegistrationValue,
  parseCodexRegistrationTimestamp,
  readCodexRegistrationEntries,
  type CodexRegistrationEntry,
  type CodexRegistrationRoot
} from './config-toml-plugin-registration-tables'

/**
 * Reconciles Codex plugin registration tables across the destructive managed-home
 * mirror. Scalar promotion covers settings the TUI writes; these are whole tables
 * Codex writes when a marketplace or plugin is registered or refreshed, and they
 * need two different conflict rules inside one baseline-aware boundary:
 *
 * | Runtime vs canonical vs baseline                     | Policy                                         |
 * | ---------------------------------------------------- | ---------------------------------------------- |
 * | in runtime, not canonical, not in baseline           | runtime-only addition -> promote the table      |
 * | in runtime, not canonical, in baseline               | canonical removal -> honor it, promote nothing  |
 * | in both, identity fields differ                      | canonical source change -> canonical wins       |
 * | in both, marketplace, newer valid `last_updated`     | promote `last_updated` + paired `last_revision` |
 * | in both, marketplace, stale/malformed `last_updated` | skip                                            |
 * | in both, plugin, `enabled` changed only in runtime   | promote `enabled`                               |
 * | in both, plugin, `enabled` changed on both sides     | canonical wins                                  |
 * | anything else                                        | canonical wins; the mirror overwrites it        |
 *
 * Presence stays canonical-owned once mirrored, so a runtime-side removal is
 * re-mirrored rather than propagated; `enabled` is the durable runtime lever.
 */

// Why: a marketplace whose source moved is a different marketplace, so its
// refresh metadata describes a clone the canonical config no longer points at.
const MARKETPLACE_IDENTITY_FIELDS = ['source_type', 'source', 'ref_name', 'sparse_paths'] as const
const PLUGIN_IDENTITY_FIELDS = ['marketplace', 'source'] as const

const MARKETPLACE_METADATA_FIELDS = ['last_updated', 'last_revision'] as const

// Why: the only registration field the baseline needs a three-way ancestor for.
const PLUGIN_BASELINE_FIELDS = ['enabled'] as const

export type CodexRegistrationPromotion =
  | { kind: 'append'; key: string; block: string }
  | { kind: 'field'; key: string; field: string; raw: string | null }

export type CodexRegistrationBaseline = ReadonlyMap<string, ReadonlyMap<string, string>>

export function planCodexRegistrationPromotion(
  runtimeConfig: string,
  systemConfig: string,
  mirroredRegistrations: CodexRegistrationBaseline
): CodexRegistrationPromotion[] {
  const runtimeEntries = readCodexRegistrationEntries(runtimeConfig)
  const systemEntries = readCodexRegistrationEntries(systemConfig)
  // Why: a marketplace must be declared before the plugins that name it, so the
  // canonical file stays readable after an install promotes both at once.
  const appends: Record<CodexRegistrationRoot, CodexRegistrationPromotion[]> = {
    marketplaces: [],
    plugins: []
  }
  const fields: CodexRegistrationPromotion[] = []
  for (const entry of runtimeEntries.values()) {
    const systemEntry = systemEntries.get(entry.key)
    if (!systemEntry) {
      if (!mirroredRegistrations.has(entry.key)) {
        appends[entry.root].push({ kind: 'append', key: entry.key, block: entry.block })
      }
      continue
    }
    if (!hasMatchingRegistrationIdentity(entry, systemEntry)) {
      continue
    }
    fields.push(
      ...(entry.root === 'marketplaces'
        ? planMarketplaceRefreshPromotion(entry, systemEntry)
        : planPluginEnablementPromotion(entry, systemEntry, mirroredRegistrations.get(entry.key)))
    )
  }
  return [...appends.marketplaces, ...appends.plugins, ...fields]
}

export function applyCodexRegistrationPromotions(
  content: string,
  promotions: readonly CodexRegistrationPromotion[]
): string {
  if (promotions.length === 0) {
    return content
  }
  const usesCrlf = content.includes('\r\n')
  const lines = content.split('\n')
  const entries = readCodexRegistrationEntries(content)
  const edits: { index: number; deleteCount: number; inserts: string[] }[] = []
  for (const promotion of promotions) {
    if (promotion.kind !== 'field') {
      continue
    }
    const entry = entries.get(promotion.key)
    const existing = entry?.fields.get(promotion.field)
    if (!entry || entry.ownerStart === -1 || existing?.multiline) {
      continue
    }
    const rendered = `${promotion.field} = ${promotion.raw}`
    if (existing) {
      edits.push({
        index: existing.lineIndex,
        deleteCount: 1,
        inserts:
          promotion.raw === null ? [] : [withTrailingCr(lines[existing.lineIndex] ?? '', rendered)]
      })
      continue
    }
    if (promotion.raw === null) {
      continue
    }
    edits.push({
      index: findTableBodyInsertIndex(lines, entry),
      deleteCount: 0,
      inserts: [withCrLine(rendered, usesCrlf)]
    })
  }
  // Why: splice from the bottom so an earlier edit never shifts an index a later
  // one was measured against.
  for (const edit of edits.sort((left, right) => right.index - left.index)) {
    lines.splice(edit.index, edit.deleteCount, ...edit.inserts)
  }
  let result = joinPreservingTrailingNewline(lines, usesCrlf)
  for (const promotion of promotions) {
    if (promotion.kind === 'append') {
      result = appendRegistrationBlock(result, promotion.block, usesCrlf)
    }
  }
  return result
}

/** The registration state a successful mirror made canonical, for the next pass's three-way. */
export function readCodexRegistrationBaseline(
  config: string
): Map<string, ReadonlyMap<string, string>> {
  const baseline = new Map<string, ReadonlyMap<string, string>>()
  for (const entry of readCodexRegistrationEntries(config).values()) {
    const tracked = new Map<string, string>()
    for (const field of getBaselineFields(entry.root)) {
      const value = entry.fields.get(field)
      if (value && !value.multiline) {
        tracked.set(field, normalizeCodexRegistrationValue(value.raw))
      }
    }
    baseline.set(entry.key, tracked)
  }
  return baseline
}

function getBaselineFields(root: CodexRegistrationRoot): readonly string[] {
  return root === 'plugins' ? PLUGIN_BASELINE_FIELDS : []
}

function hasMatchingRegistrationIdentity(
  runtimeEntry: CodexRegistrationEntry,
  systemEntry: CodexRegistrationEntry
): boolean {
  const identityFields =
    runtimeEntry.root === 'marketplaces' ? MARKETPLACE_IDENTITY_FIELDS : PLUGIN_IDENTITY_FIELDS
  return identityFields.every(
    (field) => readNormalizedField(runtimeEntry, field) === readNormalizedField(systemEntry, field)
  )
}

function planMarketplaceRefreshPromotion(
  runtimeEntry: CodexRegistrationEntry,
  systemEntry: CodexRegistrationEntry
): CodexRegistrationPromotion[] {
  const runtimeUpdated = runtimeEntry.fields.get('last_updated')
  const runtimeRevision = runtimeEntry.fields.get('last_revision')
  if (!runtimeUpdated || runtimeUpdated.multiline || runtimeRevision?.multiline) {
    return []
  }
  const runtimeTimestamp = parseCodexRegistrationTimestamp(runtimeUpdated.raw)
  if (runtimeTimestamp === null) {
    return []
  }
  const systemUpdated = systemEntry.fields.get('last_updated')
  const systemTimestamp =
    systemUpdated && !systemUpdated.multiline
      ? parseCodexRegistrationTimestamp(systemUpdated.raw)
      : null
  if (systemTimestamp !== null && runtimeTimestamp <= systemTimestamp) {
    return []
  }
  // Why: the revision names the commit the timestamp refreshed to, so promoting
  // one without the other would publish a pair that never existed together.
  return MARKETPLACE_METADATA_FIELDS.flatMap((field) =>
    buildFieldPromotion(runtimeEntry, systemEntry, field)
  )
}

function planPluginEnablementPromotion(
  runtimeEntry: CodexRegistrationEntry,
  systemEntry: CodexRegistrationEntry,
  mirrored: ReadonlyMap<string, string> | undefined
): CodexRegistrationPromotion[] {
  const runtimeValue = readNormalizedField(runtimeEntry, 'enabled')
  const systemValue = readNormalizedField(systemEntry, 'enabled')
  // Why: without a mirrored ancestor an in-Codex toggle is indistinguishable from
  // a stale runtime copy, so the canonical config stays source of truth.
  const mirroredValue = mirrored?.get('enabled') ?? null
  if (
    !mirrored ||
    runtimeValue === systemValue ||
    runtimeValue === mirroredValue ||
    systemValue !== mirroredValue
  ) {
    return []
  }
  return buildFieldPromotion(runtimeEntry, systemEntry, 'enabled')
}

function buildFieldPromotion(
  runtimeEntry: CodexRegistrationEntry,
  systemEntry: CodexRegistrationEntry,
  field: string
): CodexRegistrationPromotion[] {
  if (readNormalizedField(runtimeEntry, field) === readNormalizedField(systemEntry, field)) {
    return []
  }
  const runtimeField = runtimeEntry.fields.get(field)
  if (runtimeField?.multiline) {
    return []
  }
  return [
    {
      kind: 'field',
      key: runtimeEntry.key,
      field,
      raw: runtimeField?.raw ?? null
    }
  ]
}

function readNormalizedField(entry: CodexRegistrationEntry, field: string): string | null {
  const value = entry.fields.get(field)
  return value ? normalizeCodexRegistrationValue(value.raw) : null
}

// Why: a key added after a `[root.name.*]` subtable opens would land in the wrong
// table, so absent fields go at the owner body's end, before its trailing blanks.
function findTableBodyInsertIndex(lines: string[], entry: CodexRegistrationEntry): number {
  let insertAt = entry.ownerEnd
  while (insertAt > entry.ownerStart + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt -= 1
  }
  return insertAt
}

function appendRegistrationBlock(content: string, block: string, usesCrlf: boolean): string {
  const eol = usesCrlf ? '\r\n' : '\n'
  const rendered = block
    .split('\n')
    .map((line) => withCrLine(line.replace(/\r$/, ''), usesCrlf))
    .join('\n')
  if (content.trim() === '') {
    return `${rendered}${eol}`
  }
  const separator = content.endsWith(`${eol}${eol}`)
    ? ''
    : content.endsWith(eol)
      ? eol
      : `${eol}${eol}`
  return `${content}${separator}${rendered}${eol}`
}
