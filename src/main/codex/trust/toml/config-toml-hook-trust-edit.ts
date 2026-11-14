import type { CodexTrustEntry } from './config-toml-trust'
import {
  computeCodexTrustedHash,
  computeCodexTrustKey,
  normalizeCodexHookTrustLookupKey,
  normalizeCodexTrustSourcePath,
  parseCodexTrustKey,
  usesWindowsCodexPathSeparators
} from '../identity/codex-trust-identity'
import {
  appendHookTrustText,
  findAllHookTrustBlocks,
  findHookTrustBlockRanges,
  joinHookTrustDocument,
  readHookTrustDocumentEnding,
  replaceHookTrustSlots,
  scanHookTrustDocument,
  type HookTrustDocument
} from './config-toml-hook-trust-blocks'
import {
  CODEX_HOOK_TRUST_KEY,
  escapeTomlBasicString
} from '../../configuration/toml/config-toml-syntax'
import { repairOrcaDuplicateTrustTables } from './config-toml-project-duplicate-repair'
import { parseTomlTableHeaderPath } from '../../configuration/toml/config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from '../../configuration/toml/config-toml-line-scan'

export function upsertHookTrustContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing = repairOrcaDuplicateTrustTables(stripLeadingBom(existingContent))
  const prepared = entries.some((entry) =>
    usesWindowsCodexPathSeparators(normalizeCodexTrustSourcePath(entry.sourcePath))
  )
    ? ensureHooksStateParentTable(existing)
    : existing
  if (entries.length === 0) {
    return prepared
  }
  const document = scanHookTrustDocument(prepared)
  const writes = entries.map((entry) => ({
    keys: getTrustKeyWriteVariants(computeCodexTrustKey(entry)),
    hash: entry.trustedHash ?? computeCodexTrustedHash(entry),
    enabled: entry.enabled
  }))
  for (const [index, write] of writes.entries()) {
    if (!upsertTrustSlots(document, write.keys, write.hash, write.enabled)) {
      return writes
        .slice(index)
        .reduce(
          (updated, rest) => upsertTrustBlocks(updated, rest.keys, rest.hash, rest.enabled),
          joinHookTrustDocument(document)
        )
    }
  }
  return joinHookTrustDocument(document)
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

/** Move existing approvals without rehashing; unknown stored key shapes prevent all moves. */
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
  if (
    bodies.some(({ newKey }) =>
      usesWindowsCodexPathSeparators(parseCodexTrustKey(newKey)?.sourcePath ?? '')
    )
  ) {
    updated = ensureHooksStateParentTable(updated)
  }
  return appendHookTrustBlocks(
    updated,
    bodies.flatMap(({ newKey, body }) =>
      getTrustKeyWriteVariants(newKey).map(
        (key) => `[hooks.state.${formatHookStateTableKey(key)}]${body ? `\n${body}` : ''}`
      )
    )
  )
}

export function readHookTrustBlockTexts(content: string, key: string): string[] {
  return findHookTrustBlockRanges(content, new Set([normalizeCodexHookTrustLookupKey(key)])).map(
    (range) => content.slice(range.start, range.end).trimEnd()
  )
}

export function restoreHookTrustBlockContent(
  content: string,
  restores: readonly { key: string; blocks: readonly string[] }[]
): string {
  return appendHookTrustBlocks(
    removeHookTrustContent(
      content,
      restores.map(({ key }) => key)
    ),
    restores.flatMap(({ blocks }) => blocks)
  )
}

function appendHookTrustBlocks(content: string, blocks: readonly string[]): string {
  if (blocks.length === 0) {
    return content
  }
  return `${content}${getAppendSeparator(content.slice(-2))}${blocks.join('\n\n')}\n`
}

function getAppendSeparator(ending: string): string {
  return ending.length === 0 || ending.endsWith('\n\n') ? '' : ending.endsWith('\n') ? '\n' : '\n\n'
}

// Same outcome as sequential upsertTrustBlocks calls; false asks the caller to continue with them.
function upsertTrustSlots(
  document: HookTrustDocument,
  keys: readonly string[],
  hash: string,
  explicitEnabled?: boolean
): boolean {
  const normalizedKeys = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  const [slots, ...otherMatches] = [...normalizedKeys].flatMap((key) => {
    const matched = document.slotsByKey.get(key)
    return matched ? [matched] : []
  })
  if (!slots) {
    const separator = getAppendSeparator(readHookTrustDocumentEnding(document))
    const block = buildTrustBlocks(keys, hash, explicitEnabled ?? true)
    appendHookTrustText(document, `${separator}${block}\n`)
    return true
  }
  // Slots indexed under different lookup keys have no tracked relative order.
  if (otherMatches.length > 0) {
    return false
  }
  const enabled = explicitEnabled ?? !slots.some((slot) => isBlockDisabled(slot.chunks.join('')))
  const block = buildTrustBlocks(keys, hash, enabled)
  return replaceHookTrustSlots(document, slots, `${block}\n`, normalizedKeys)
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
    return appendHookTrustBlocks(content, [buildTrustBlocks(keys, hash, explicitEnabled ?? true)])
  }
  const enabled =
    explicitEnabled ??
    !ranges.some((range) => isBlockDisabled(content.slice(range.start, range.end)))
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

// The header line cannot match, so scanning the whole range equals scanning its body.
function isBlockDisabled(block: string): boolean {
  const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t\r]*(?:#.*)?$/m.exec(block)
  return enabledMatch?.[1] === 'false'
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

/** Write both separator forms for Windows trust keys. */
export function getTrustKeyWriteVariants(key: string): string[] {
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

function ensureHooksStateParentTable(content: string): string {
  const { hasParent, firstChildOffset } = findHooksStateHeaders(content)
  if (hasParent) {
    return content
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const parent = `[hooks.state]${eol}`
  if (firstChildOffset !== null) {
    return `${content.slice(0, firstChildOffset)}${parent}${eol}${content.slice(firstChildOffset)}`
  }
  if (content.length === 0) {
    return parent
  }
  const separator = content.endsWith(`${eol}${eol}`) ? '' : content.endsWith(eol) ? eol : eol + eol
  return `${content}${separator}${parent}`
}

// Quoted and bare hooks.state headers identify the same table.
function findHooksStateHeaders(content: string): {
  hasParent: boolean
  firstChildOffset: number | null
} {
  let firstChildOffset: number | null = null
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < content.length) {
    const newlineIndex = content.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? content.length : newlineIndex
    const line = content.slice(cursor, lineEnd).replace(/\r$/, '')
    if (isTomlStructuralLine(scanState)) {
      const header = getTomlTableHeader(line)
      const table = header === null ? null : parseTomlTableHeaderPath(header)
      if (
        table &&
        !table.isArray &&
        table.segments[0] === 'hooks' &&
        table.segments[1] === 'state'
      ) {
        if (table.segments.length === 2) {
          return { hasParent: true, firstChildOffset }
        }
        firstChildOffset ??= cursor
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
    if (newlineIndex === -1) {
      break
    }
    cursor = newlineIndex + 1
  }
  return { hasParent: false, firstChildOffset }
}

function stripLeadingBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
}
