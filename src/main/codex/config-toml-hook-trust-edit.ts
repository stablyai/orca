import type { CodexTrustEntry } from './config-toml-trust'
import {
  computeCodexTrustedHash,
  computeCodexTrustKey,
  normalizeCodexHookTrustLookupKey,
  normalizeCodexTrustSourcePath,
  parseCodexTrustKey,
  usesWindowsCodexPathSeparators
} from './codex-trust-identity'
import {
  ensureHooksStateParentTable,
  findAllHookTrustBlocks,
  findHookTrustBlockRanges,
  type HookTrustBlockRange
} from './config-toml-hook-trust-blocks'
import { CODEX_HOOK_TRUST_KEY, escapeTomlBasicString } from './config-toml-syntax'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'

export function upsertHookTrustContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing = repairOrcaDuplicateTrustTables(stripLeadingBom(existingContent))
  let updated = entries.some((entry) =>
    usesWindowsCodexPathSeparators(normalizeCodexTrustSourcePath(entry.sourcePath))
  )
    ? ensureHooksStateParentTable(existing)
    : existing
  for (const entry of entries) {
    updated = upsertTrustBlocks(
      updated,
      getTrustKeyWriteVariants(computeCodexTrustKey(entry)),
      entry.trustedHash ?? computeCodexTrustedHash(entry),
      entry.enabled
    )
  }
  return updated
}

export function removeHookTrustContent(content: string, keys: readonly string[]): string {
  const normalizedKeys = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  const ranges = findHookTrustBlockRanges(content, normalizedKeys)
  if (ranges.length === 0) {
    return content
  }
  let cursor = 0
  let updated = ''
  for (const range of ranges) {
    updated += content.slice(cursor, range.start)
    cursor = range.end
  }
  return updated + content.slice(cursor)
}

/**
 * Moves each hook's trust block to the hook's new key, body bytes unchanged:
 * only what Codex wrote moves, and no hash is ever computed. Codex hashes a
 * hook's content, not its path or position, so the moved block stays exactly
 * as valid as before; a hook with no block keeps none. If any stored key has
 * an unknown shape, nothing moves and Codex asks the user to review instead.
 */
export function moveHookTrustContent(
  existingContent: string,
  moves: readonly { oldKey: string; newKey: string }[]
): string {
  const content = stripLeadingBom(existingContent)
  if (findAllHookTrustBlocks(content).some(({ key }) => !CODEX_HOOK_TRUST_KEY.test(key))) {
    return existingContent
  }
  const bodies = moves.flatMap(({ oldKey, newKey }) => {
    const [range] = findHookTrustBlockRanges(
      content,
      new Set([normalizeCodexHookTrustLookupKey(oldKey)])
    )
    return range ? [{ newKey, body: content.slice(range.contentStart, range.end).trimEnd() }] : []
  })
  let updated = removeHookTrustContent(content, [
    ...moves.map(({ oldKey }) => oldKey),
    ...moves.map(({ newKey }) => newKey)
  ])
  if (bodies.length === 0) {
    return updated
  }
  if (
    bodies.some(({ newKey }) =>
      usesWindowsCodexPathSeparators(parseCodexTrustKey(newKey)?.sourcePath ?? '')
    )
  ) {
    updated = ensureHooksStateParentTable(updated)
  }
  const blocks = bodies.flatMap(({ newKey, body }) =>
    getTrustKeyWriteVariants(newKey).map(
      (key) => `[hooks.state.${formatHookStateTableKey(key)}]${body ? `\n${body}` : ''}`
    )
  )
  const separator =
    updated.length === 0 || updated.endsWith('\n\n') ? '' : updated.endsWith('\n') ? '\n' : '\n\n'
  return `${updated}${separator}${blocks.join('\n\n')}\n`
}

function upsertTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  explicitEnabled?: boolean
): string {
  const ranges = findHookTrustBlockRanges(
    content,
    new Set(keys.map(normalizeCodexHookTrustLookupKey))
  )
  if (ranges.length === 0) {
    return appendTrustBlocks(content, keys, hash, explicitEnabled ?? true)
  }
  const enabled = explicitEnabled ?? !ranges.some((range) => isBlockDisabled(content, range))
  const block = buildTrustBlocks(keys, hash, enabled)
  let cursor = 0
  let deduped = ''
  ranges.forEach((range, index) => {
    deduped += content.slice(cursor, range.start)
    if (index === 0) {
      deduped += `${block}\n`
    }
    cursor = range.end
  })
  return deduped + content.slice(cursor)
}

function isBlockDisabled(content: string, range: HookTrustBlockRange): boolean {
  const block = content.slice(range.headerLineEnd, range.end)
  const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(block)
  return enabledMatch?.[1] === 'false'
}

function appendTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  enabled: boolean
): string {
  const block = buildTrustBlocks(keys, hash, enabled)
  if (content.length === 0) {
    return `${block}\n`
  }
  const separator = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
  return `${content}${separator}${block}\n`
}

function buildTrustBlocks(keys: readonly string[], hash: string, enabled: boolean): string {
  return keys.map((key) => buildTrustBlock(key, hash, enabled)).join('\n\n')
}

function buildTrustBlock(key: string, hash: string, enabled: boolean): string {
  return [
    `[hooks.state.${formatHookStateTableKey(key)}]`,
    `enabled = ${enabled}`,
    `trusted_hash = "${escapeTomlBasicString(hash)}"`
  ].join('\n')
}

function formatHookStateTableKey(key: string): string {
  const parsed = parseCodexTrustKey(key)
  if (parsed && usesWindowsCodexPathSeparators(parsed.sourcePath) && !key.includes("'")) {
    return `'${key}'`
  }
  return `"${escapeTomlBasicString(key)}"`
}

function getTrustKeyWriteVariants(key: string): string[] {
  const parsed = parseCodexTrustKey(key)
  if (!parsed || !usesWindowsCodexPathSeparators(parsed.sourcePath)) {
    return [key]
  }
  const suffix = `:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
  return [
    `${parsed.sourcePath.replace(/\//g, '\\')}${suffix}`,
    `${parsed.sourcePath.replace(/\\/g, '/')}${suffix}`
  ].filter((variant, index, variants) => variants.indexOf(variant) === index)
}

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
