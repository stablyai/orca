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
  findHookTrustBlockRanges,
  type HookTrustBlockRange
} from './config-toml-hook-trust-blocks'
import { escapeTomlBasicString } from './config-toml-syntax'

export function upsertHookTrustContent(
  existingContent: string,
  entries: readonly CodexTrustEntry[]
): string {
  const existing = stripLeadingBom(existingContent)
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

function upsertTrustBlocks(
  content: string,
  keys: readonly string[],
  hash: string,
  explicitEnabled?: boolean
): string {
  const ranges = getUniqueTrustBlockRanges(content, keys)
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

function getUniqueTrustBlockRanges(
  content: string,
  keys: readonly string[]
): HookTrustBlockRange[] {
  const normalizedKeys = new Set(keys.map(normalizeCodexHookTrustLookupKey))
  return findHookTrustBlockRanges(content, normalizedKeys)
    .filter(
      (range, index, ranges) =>
        ranges.findIndex(
          (candidate) => candidate.start === range.start && candidate.end === range.end
        ) === index
    )
    .sort((left, right) => left.start - right.start)
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
