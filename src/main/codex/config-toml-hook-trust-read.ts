import { parse as parseToml } from 'smol-toml'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
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
  const result = readHookTrustTables(content)
  // Why: approvals written as dotted keys or inline tables have no [hooks.state."k"] header.
  for (const [key, state] of readParsedHookTrust(content)) {
    if (!result.has(key)) {
      result.set(key, state)
    }
  }
  return result
}

function readParsedHookTrust(content: string): [string, CodexHookTrustState][] {
  let parsed: unknown
  try {
    parsed = parseToml(content)
  } catch {
    return []
  }
  const hooks = isPlainObject(parsed) ? parsed.hooks : undefined
  const state = isPlainObject(hooks) ? hooks.state : undefined
  if (!isPlainObject(state)) {
    return []
  }
  return Object.entries(state).flatMap(([key, value]): [string, CodexHookTrustState][] =>
    isPlainObject(value)
      ? [
          [
            key,
            {
              trustedHash: typeof value.trusted_hash === 'string' ? value.trusted_hash : undefined,
              enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined
            }
          ]
        ]
      : []
  )
}

function readHookTrustTables(content: string): CodexHookTrustEntryMap {
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
      // Why both forms: a literal-string hash must not read as "no approval".
      const hashMatch =
        /^[ \t]*trusted_hash[ \t]*=[ \t]*(?:"((?:[^"\\]|\\.)*)"|'([^'\r\n]*)')[ \t]*(?:#.*)?$/.exec(
          line
        )
      if (hashMatch) {
        trustedHashes.add(
          hashMatch[1] !== undefined ? unescapeTomlBasicString(hashMatch[1]) : hashMatch[2]!
        )
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
