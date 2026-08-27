import type { CodexHookTrustState } from './config-toml-trust'
import { normalizeCodexHookTrustLookupKey } from './codex-trust-identity'
import { findAllHookTrustBlocks } from './config-toml-hook-trust-blocks'
import {
  createTomlLineScanState,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { unescapeTomlBasicString } from './config-toml-syntax'

export class CodexHookTrustEntryMap extends Map<string, CodexHookTrustState> {
  override get(key: string): CodexHookTrustState | undefined {
    return super.get(normalizeCodexHookTrustLookupKey(key))
  }

  override has(key: string): boolean {
    return super.has(normalizeCodexHookTrustLookupKey(key))
  }

  override delete(key: string): boolean {
    return super.delete(normalizeCodexHookTrustLookupKey(key))
  }

  override set(key: string, value: CodexHookTrustState): this {
    return super.set(normalizeCodexHookTrustLookupKey(key), value)
  }
}

export function readHookTrustContent(content: string): Map<string, CodexHookTrustState> {
  const result = new CodexHookTrustEntryMap()
  const conflictingTrustedHashKeys = new Set<string>()
  for (const block of findAllHookTrustBlocks(content)) {
    const state = readHookTrustBlockState(content.slice(block.contentStart, block.end))
    const normalizedKey = normalizeCodexHookTrustLookupKey(block.key)
    const existingState = result.get(normalizedKey)
    const trustedHash =
      state.trustedHashes.size === 1 ? state.trustedHashes.values().next().value : undefined
    if (
      state.trustedHashes.size > 1 ||
      (trustedHash !== undefined &&
        existingState?.trustedHash !== undefined &&
        existingState.trustedHash !== trustedHash)
    ) {
      conflictingTrustedHashKeys.add(normalizedKey)
    }
    result.set(normalizedKey, {
      trustedHash: conflictingTrustedHashKeys.has(normalizedKey)
        ? undefined
        : (trustedHash ?? existingState?.trustedHash),
      enabled:
        existingState?.enabled === false || state.enabled === false
          ? false
          : (state.enabled ?? existingState?.enabled)
    })
  }
  return result
}

function readHookTrustBlockState(block: string): {
  trustedHashes: Set<string>
  enabled?: boolean
} {
  const trustedHashes = new Set<string>()
  let enabled: boolean | undefined
  let cursor = 0
  let scanState = createTomlLineScanState()
  while (cursor < block.length) {
    const newlineIndex = block.indexOf('\n', cursor)
    const lineEnd = newlineIndex === -1 ? block.length : newlineIndex
    const line = block.slice(cursor, lineEnd).replace(/\r$/, '')
    if (isTomlStructuralLine(scanState)) {
      const hashMatch = /^[ \t]*trusted_hash[ \t]*=[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*(?:#.*)?$/.exec(
        line
      )
      if (hashMatch) {
        trustedHashes.add(unescapeTomlBasicString(hashMatch[1]!))
      }
      const enabledMatch = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)[ \t]*(?:#.*)?$/.exec(line)
      if (enabledMatch) {
        enabled = enabled !== false && enabledMatch[1] === 'true'
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
    cursor = newlineIndex === -1 ? block.length : newlineIndex + 1
  }
  return { trustedHashes, enabled }
}
