import type { HookDefinition } from '../../../agent-hooks/installation/configuration/hook-config-schema'
import {
  readHookTrustEntries,
  type CodexHookTrustState,
  type CodexTrustEntry
} from '../toml/config-toml-trust'
import {
  codexTrustSourcePathsEqual as codexHookSourcePathsEqual,
  computeCodexTrustKey as computeTrustKey,
  computeCodexTrustedHash as computeTrustedHash,
  normalizeCodexHookTrustLookupKey as normalizeTrustKey,
  normalizeCodexTrustSourcePath as normalizeCodexHookSourcePath,
  parseCodexTrustKey as parseTrustKey
} from '../identity/codex-trust-identity'
import {
  createCodexHookTrustEntry,
  getCodexUserHookMirrorSignature
} from '../../hooks/definitions/codex-hook-identity'
import { getSystemCodexConfigTomlPath } from '../../hooks/definitions/codex-hook-definition'

export type TrustedSystemHookSignatureState = {
  enabled: boolean
  trustedHash: string
}

/** Each signature's states in ~/.codex order, null for an occurrence that holds no trust. */
export type TrustedSystemHookSignatures = Map<string, (TrustedSystemHookSignatureState | null)[]>

type SystemUserHook = { entry: CodexTrustEntry; key: string; expectedHash: string }

export function getTrustedSystemUserHookSignatures(
  systemConfigPath: string,
  systemHooks: Record<string, HookDefinition[]>,
  isManagedCommand: (command: string | undefined) => boolean
): TrustedSystemHookSignatures {
  const signatures: TrustedSystemHookSignatures = new Map()
  let trustEntries: Map<string, CodexHookTrustState>
  try {
    trustEntries = readHookTrustEntries(getSystemCodexConfigTomlPath())
  } catch (error) {
    // Invalid system config disables user-trust mirroring without blocking managed hooks.
    console.warn('[codex-hook-service] failed to read system hook trust entries', error)
    return signatures
  }
  const hooks = listSystemUserHooks(systemConfigPath, systemHooks, isManagedCommand)
  const moves = findUnambiguousTrustMoves(systemConfigPath, hooks, trustEntries)
  for (const hook of hooks) {
    const state = resolveTrustedSystemHookState(hook, trustEntries, moves)
    const signature = getCodexUserHookMirrorSignature(hook.entry)
    signatures.set(signature, [...(signatures.get(signature) ?? []), state])
  }
  return signatures
}

function listSystemUserHooks(
  systemConfigPath: string,
  systemHooks: Record<string, HookDefinition[]>,
  isManagedCommand: (command: string | undefined) => boolean
): SystemUserHook[] {
  const hooks: SystemUserHook[] = []
  for (const [eventName, definitions] of Object.entries(systemHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      const handlers = Array.isArray(definition.hooks) ? definition.hooks : []
      handlers.forEach((hook, handlerIndex) => {
        if (isManagedCommand(hook.command)) {
          return
        }
        const entry = createCodexHookTrustEntry(
          systemConfigPath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (entry) {
          hooks.push({
            entry,
            key: computeTrustKey(entry),
            expectedHash: computeTrustedHash(entry)
          })
        }
      })
    })
  }
  return hooks
}

function resolveTrustedSystemHookState(
  { key, expectedHash }: SystemUserHook,
  trustEntries: ReadonlyMap<string, CodexHookTrustState>,
  moves: ReadonlyMap<string, CodexHookTrustState>
): TrustedSystemHookSignatureState | null {
  const state = trustEntries.get(key)
  if (state?.trustedHash === expectedHash) {
    return { enabled: state.enabled !== false, trustedHash: expectedHash }
  }
  if (state?.trustedHash && state.enabled === false) {
    // A disable at this position stands even when the hook changed since.
    return { enabled: false, trustedHash: state.trustedHash }
  }
  const moved = moves.get(key)
  if (moved) {
    return { enabled: moved.enabled !== false, trustedHash: expectedHash }
  }
  if (state?.trustedHash) {
    // #7110: preserve Codex's verbatim hash to avoid reapproval loops from recomputation.
    return { enabled: state.enabled !== false, trustedHash: state.trustedHash }
  }
  return null
}

/**
 * Content hashes carry approval across reorders, but only where one stale record and one hook
 * share the hash: otherwise a disabled or never-approved copy could inherit another's approval.
 */
function findUnambiguousTrustMoves(
  systemConfigPath: string,
  hooks: readonly SystemUserHook[],
  trustEntries: ReadonlyMap<string, CodexHookTrustState>
): Map<string, CodexHookTrustState> {
  const canonicalSystemConfigPath = normalizeCodexHookSourcePath(systemConfigPath)
  const hashAtKey = new Map(hooks.map((hook) => [normalizeTrustKey(hook.key), hook.expectedHash]))
  const staleRecords = new Map<string, CodexHookTrustState[]>()
  for (const [key, state] of trustEntries) {
    const parsed = parseTrustKey(key)
    if (
      !parsed ||
      !state.trustedHash ||
      !codexHookSourcePathsEqual(parsed.sourcePath, canonicalSystemConfigPath) ||
      hashAtKey.get(normalizeTrustKey(key)) === state.trustedHash
    ) {
      continue
    }
    const group = `${parsed.eventLabel}\0${state.trustedHash}`
    staleRecords.set(group, [...(staleRecords.get(group) ?? []), state])
  }
  const unmatchedHooks = new Map<string, SystemUserHook[]>()
  for (const hook of hooks) {
    if (trustEntries.get(hook.key)?.trustedHash !== hook.expectedHash) {
      const group = `${hook.entry.eventLabel}\0${hook.expectedHash}`
      unmatchedHooks.set(group, [...(unmatchedHooks.get(group) ?? []), hook])
    }
  }
  const moves = new Map<string, CodexHookTrustState>()
  for (const [group, candidates] of unmatchedHooks) {
    const records = staleRecords.get(group)
    if (candidates.length === 1 && records?.length === 1) {
      moves.set(candidates[0].key, records[0])
    }
  }
  return moves
}
