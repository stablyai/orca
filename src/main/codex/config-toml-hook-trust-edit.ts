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
import {
  CODEX_HOOK_TRUST_KEY,
  escapeTomlBasicString,
  parseHookStateTomlHeaderKey
} from './config-toml-syntax'
import { applyCheckedCodexConfigTomlEdit } from './codex-config-toml-checked-edit'
import { readTomlValueAtPath } from './codex-config-toml-document'
import {
  readTomlAssignmentValue,
  scanTomlStructure,
  tomlKeyPathsEqual
} from './codex-config-toml-structure'

export function upsertHookTrustContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  // Why: nothing to write, so a config Codex cannot parse must not turn into a refusal.
  if (entries.length === 0) {
    return existingContent
  }
  const existing = stripLeadingBom(existingContent)
  const writes = entries.map((entry) => ({
    keys: getTrustKeyWriteVariants(computeCodexTrustKey(entry)),
    hash: entry.trustedHash ?? computeCodexTrustedHash(entry),
    explicitEnabled: entry.enabled
  }))
  const needsParentTable = entries.some((entry) =>
    usesWindowsCodexPathSeparators(normalizeCodexTrustSourcePath(entry.sourcePath))
  )
  const updated = applyCheckedCodexConfigTomlEdit(
    existing,
    (content) => {
      let next = needsParentTable ? ensureHooksStateParentTable(content) : content
      for (const write of writes) {
        next = upsertTrustBlocks(next, write.keys, write.hash, write.explicitEnabled)
      }
      return {
        content: next,
        ownedPaths: getOwnedHookStatePaths(
          content,
          writes.flatMap((write) => write.keys)
        ),
        expected: writes.flatMap((write) =>
          write.keys.map((key) => ({
            path: ['hooks', 'state', key, 'trusted_hash'],
            value: write.hash
          }))
        )
      }
    },
    {
      collapsesOwnedDuplicates: (content) =>
        stripHookTrustBlocks(
          content,
          new Set(writes.flatMap((write) => write.keys).map(normalizeCodexHookTrustLookupKey))
        )
    }
  )
  return updated === existing ? existingContent : updated
}

function stripHookTrustBlocks(content: string, normalizedKeys: ReadonlySet<string>): string {
  let cursor = 0
  let stripped = ''
  for (const range of findHookTrustBlockRanges(content, normalizedKeys)) {
    stripped += content.slice(cursor, range.start)
    cursor = range.end
  }
  return stripped + content.slice(cursor)
}

export function removeHookTrustContent(content: string, keys: readonly string[]): string {
  const normalizedKeys = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  if (findHookTrustBlockRanges(content, normalizedKeys).length === 0) {
    return content
  }
  return applyCheckedCodexConfigTomlEdit(
    content,
    (input) => ({
      content: stripHookTrustBlocks(input, normalizedKeys),
      ownedPaths: getOwnedHookStatePaths(input, keys)
    }),
    { collapsesOwnedDuplicates: (input) => stripHookTrustBlocks(input, normalizedKeys) }
  )
}

/** Sets `enabled` on existing hooks.state tables only; a missing table stays missing. */
export function setHookTrustEnabledContent(
  existingContent: string,
  states: readonly { key: string; enabled: boolean }[]
): string {
  const existing = stripLeadingBom(existingContent)
  const keys = new Set(states.map((state) => normalizeCodexHookTrustLookupKey(state.key)))
  if (findHookTrustBlockRanges(existing, keys).length === 0) {
    return existingContent
  }
  const updated = applyCheckedCodexConfigTomlEdit(existing, (content) => {
    let next = content
    for (const { key, enabled } of states) {
      next = setEnabledInTrustBlocks(next, key, enabled)
    }
    return {
      content: next,
      ownedPaths: getOwnedHookStatePaths(
        content,
        states.map((state) => state.key)
      ).map((path) => [...path, 'enabled'])
    }
  })
  return updated === existing ? existingContent : updated
}

function setEnabledInTrustBlocks(content: string, key: string, enabled: boolean): string {
  const ranges = findHookTrustBlockRanges(content, new Set([normalizeCodexHookTrustLookupKey(key)]))
  let next = content
  // Why: no toReversed(); the SSH relay runs this on Node 18.
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]
    const enabledLine = scanTomlStructure(next.slice(range.contentStart, range.end)).find(
      (line) => line.kind === 'assignment' && tomlKeyPathsEqual(line.keySegments, ['enabled'])
    )
    if (enabledLine?.kind === 'assignment') {
      const valueStart = range.contentStart + enabledLine.lineStart + enabledLine.valueOffset
      const token = /^(?:true|false)/.exec(next.slice(valueStart))
      if (token) {
        next = `${next.slice(0, valueStart)}${enabled}${next.slice(valueStart + token[0].length)}`
      }
    } else if (!enabled) {
      const eol = next.includes('\r\n') ? '\r\n' : '\n'
      next = `${next.slice(0, range.contentStart)}enabled = false${eol}${next.slice(range.contentStart)}`
    }
  }
  return next
}

/** The written keys plus every spelling of them the edit replaces. */
function getOwnedHookStatePaths(content: string, keys: readonly string[]): string[][] {
  const normalized = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  const owned = new Set(keys)
  for (const block of findAllHookTrustBlocks(content)) {
    if (normalized.has(normalizeCodexHookTrustLookupKey(block.key))) {
      owned.add(block.key)
    }
  }
  return [...owned].map((key) => ['hooks', 'state', key])
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
  const existing = stripLeadingBom(existingContent)
  const touchedKeys = new Set(
    moves.flatMap(({ oldKey, newKey }) => [oldKey, newKey]).map(normalizeCodexHookTrustLookupKey)
  )
  // Why: nothing to move, so a config Codex cannot parse must not turn into a refusal.
  if (
    findHookTrustBlockRanges(existing, touchedKeys).length === 0 ||
    findAllHookTrustBlocks(existing).some(({ key }) => !CODEX_HOOK_TRUST_KEY.test(key))
  ) {
    return existingContent
  }
  const updated = applyCheckedCodexConfigTomlEdit(
    existing,
    (content, table) => {
      const moved = moves.flatMap(({ oldKey, newKey }) => {
        const [range] = findHookTrustBlockRanges(
          content,
          new Set([normalizeCodexHookTrustLookupKey(oldKey)])
        )
        const sourceKey = range
          ? parseHookStateTomlHeaderKey(content.slice(range.start, range.headerLineEnd))
          : null
        return range && sourceKey !== null
          ? [
              {
                sourceKey,
                newKey,
                newKeys: getTrustKeyWriteVariants(newKey),
                body: content.slice(range.contentStart, range.end).trimEnd()
              }
            ]
          : []
      })
      let next = stripHookTrustBlocks(content, touchedKeys)
      if (moved.length > 0) {
        if (
          moved.some(({ newKey }) =>
            usesWindowsCodexPathSeparators(parseCodexTrustKey(newKey)?.sourcePath ?? '')
          )
        ) {
          next = ensureHooksStateParentTable(next)
        }
        const blocks = moved.flatMap(({ newKeys, body }) =>
          newKeys.map(
            (key) => `[hooks.state.${formatHookStateTableKey(key)}]${body ? `\n${body}` : ''}`
          )
        )
        next = appendTomlBlock(next, blocks.join('\n\n'))
      }
      return {
        content: next,
        ownedPaths: getOwnedHookStatePaths(content, [
          ...moves.flatMap(({ oldKey, newKey }) => [oldKey, newKey]),
          ...moved.flatMap(({ newKeys }) => newKeys)
        ]),
        // Why: a move carries the block's values unchanged, so each new key must hold them.
        expected: table
          ? moved.flatMap(({ sourceKey, newKeys }) =>
              newKeys.map((key) => ({
                path: ['hooks', 'state', key],
                value: readTomlValueAtPath(table, ['hooks', 'state', sourceKey])
              }))
            )
          : []
      }
    },
    { collapsesOwnedDuplicates: (content) => stripHookTrustBlocks(content, touchedKeys) }
  )
  return updated === existing ? existingContent : updated
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
    return appendTomlBlock(content, buildTrustBlocks(keys, hash, explicitEnabled ?? true))
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
  return scanTomlStructure(content.slice(range.contentStart, range.end)).some(
    (line) =>
      line.kind === 'assignment' &&
      tomlKeyPathsEqual(line.keySegments, ['enabled']) &&
      readTomlAssignmentValue(line) === false
  )
}

function appendTomlBlock(content: string, block: string): string {
  const separator =
    content.length === 0 || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n'
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
