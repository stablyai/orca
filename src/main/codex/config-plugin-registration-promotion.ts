import { joinPreservingTrailingNewline, withCrLine, withTrailingCr } from './config-toml-line-scan'
import {
  normalizeCodexRegistrationValue,
  parseCodexRegistrationTimestamp,
  readCodexRegistrationEntries,
  type CodexRegistrationEntry,
  type CodexRegistrationRoot
} from './config-toml-plugin-registration-tables'

/** Promote runtime additions and edits while honoring canonical removals and identity changes. */

// A changed marketplace source invalidates refresh metadata from the old clone.
const MARKETPLACE_IDENTITY_FIELDS = ['source_type', 'source', 'ref_name', 'sparse_paths'] as const
const PLUGIN_IDENTITY_FIELDS = ['marketplace', 'source'] as const

const MARKETPLACE_METADATA_FIELDS = ['last_updated', 'last_revision'] as const

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
  // Declare marketplaces before the plugins that reference them.
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
  // Apply from the bottom to preserve recorded line indices.
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
  // Do not promote a timestamp when its paired revision would be lost.
  if (!runtimeRevision && systemEntry.fields.has('last_revision')) {
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
  // Promote the timestamp and revision together to preserve their pairing.
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
  // Without a mirrored ancestor, a runtime toggle is indistinguishable from a stale copy.
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

// Insert in the owner body so later subtables cannot capture the new field.
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
