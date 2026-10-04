import type { CodexHookTrustState } from './config-toml-trust'
import { normalizeCodexHookTrustLookupKey } from './codex-trust-identity'
import { findAllHookTrustBlocks } from './config-toml-hook-trust-blocks'
import { getTomlTable, parseCodexConfigToml } from './codex-config-toml-document'
import {
  readTomlAssignmentValue,
  scanTomlStructure,
  tomlKeyPathsEqual
} from './codex-config-toml-structure'

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

type HookTrustStateSource = { key: string; trustedHashes: Set<string>; enabled?: boolean }

export function readHookTrustContent(content: string): Map<string, CodexHookTrustState> {
  const result = new CodexHookTrustEntryMap()
  const conflictingTrustedHashKeys = new Set<string>()
  for (const state of readHookTrustStateSources(content)) {
    const normalizedKey = normalizeCodexHookTrustLookupKey(state.key)
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

/** Reads what Codex reads when the file parses (any spelling, inline or dotted); scans tables otherwise. */
function readHookTrustStateSources(content: string): HookTrustStateSource[] {
  const parsed = parseCodexConfigToml(content)
  if (parsed.ok) {
    const states = getTomlTable(getTomlTable(parsed.table.hooks)?.state) ?? {}
    return Object.entries(states).flatMap(([key, value]) => {
      const state = getTomlTable(value)
      if (!state) {
        return []
      }
      const trustedHashes = new Set<string>()
      if (typeof state.trusted_hash === 'string') {
        trustedHashes.add(state.trusted_hash)
      }
      return [
        {
          key,
          trustedHashes,
          enabled: typeof state.enabled === 'boolean' ? state.enabled : undefined
        }
      ]
    })
  }
  return findAllHookTrustBlocks(content).map((block) => ({
    key: block.key,
    ...readHookTrustBlockState(content.slice(block.contentStart, block.end))
  }))
}

function readHookTrustBlockState(block: string): {
  trustedHashes: Set<string>
  enabled?: boolean
} {
  const trustedHashes = new Set<string>()
  let enabled: boolean | undefined
  for (const line of scanTomlStructure(block)) {
    if (line.kind !== 'assignment' || line.table.segments.length > 0) {
      continue
    }
    const value = readTomlAssignmentValue(line)
    if (tomlKeyPathsEqual(line.keySegments, ['trusted_hash']) && typeof value === 'string') {
      trustedHashes.add(value)
    }
    if (tomlKeyPathsEqual(line.keySegments, ['enabled']) && typeof value === 'boolean') {
      enabled = enabled !== false && value
    }
  }
  return { trustedHashes, enabled }
}
