import type { HookDefinition } from '../agent-hooks/installer-utils'
import {
  codexHookSourcePathsEqual,
  computeTrustKey,
  computeTrustedHash,
  normalizeCodexHookSourcePath,
  parseTrustKey,
  readHookTrustEntries,
  type CodexEventLabel,
  type CodexHookTrustState,
  type CodexTrustEntry
} from './config-toml-trust'
import { createCodexHookTrustEntry, getCodexHookTrustSignature } from './codex-hook-identity'
import { getSystemCodexConfigTomlPath } from './codex-hook-definition'

export type TrustedSystemHookSignatureState = {
  enabled: boolean
  trustedHash: string
}

export function getTrustedSystemUserHookSignatures(
  systemConfigPath: string,
  systemHooks: Record<string, HookDefinition[]>,
  isManagedCommand: (command: string | undefined) => boolean
): Map<string, TrustedSystemHookSignatureState> {
  const signatures = new Map<string, TrustedSystemHookSignatureState>()
  let trustEntries: Map<string, CodexHookTrustState>
  try {
    trustEntries = readHookTrustEntries(getSystemCodexConfigTomlPath())
  } catch (error) {
    // Why: a hand-broken system config.toml should only disable user-hook trust mirroring, not block Orca's managed runtime hooks.
    console.warn('[codex-hook-service] failed to read system hook trust entries', error)
    return signatures
  }
  const trustedHashesByEvent = getTrustedSystemHookHashesByEvent(systemConfigPath, trustEntries)
  for (const [eventName, definitions] of Object.entries(systemHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
      hooks.forEach((hook, handlerIndex) => {
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
        if (!entry) {
          return
        }
        const state = resolveTrustedSystemHookState(entry, trustEntries, trustedHashesByEvent)
        if (!state) {
          return
        }
        const signature = getCodexHookTrustSignature(entry)
        // Why: runtime deduping collapses identical definitions; if any duplicate stays enabled, keep the mirrored hook enabled.
        if (state.enabled || !signatures.has(signature)) {
          signatures.set(signature, state)
        }
      })
    })
  }
  return signatures
}

function resolveTrustedSystemHookState(
  entry: CodexTrustEntry,
  trustEntries: ReadonlyMap<string, CodexHookTrustState>,
  trustedHashesByEvent: ReadonlyMap<CodexEventLabel, Map<string, boolean>>
): TrustedSystemHookSignatureState | null {
  const expectedHash = computeTrustedHash(entry)
  const state = trustEntries.get(computeTrustKey(entry))
  if (state?.trustedHash === expectedHash) {
    return { enabled: state.enabled !== false, trustedHash: expectedHash }
  }
  const reorderedEnabled = trustedHashesByEvent.get(entry.eventLabel)?.get(expectedHash)
  if (reorderedEnabled !== undefined) {
    return { enabled: reorderedEnabled, trustedHash: expectedHash }
  }
  if (state?.trustedHash) {
    // Why: carry a key-matched system hash verbatim — recomputing caused #7110 re-approval loops since Codex owns its hash algorithm.
    return { enabled: state.enabled !== false, trustedHash: state.trustedHash }
  }
  return null
}

function getTrustedSystemHookHashesByEvent(
  systemConfigPath: string,
  trustEntries: ReadonlyMap<string, CodexHookTrustState>
): Map<CodexEventLabel, Map<string, boolean>> {
  const trustedHashesByEvent = new Map<CodexEventLabel, Map<string, boolean>>()
  const canonicalSystemConfigPath = normalizeCodexHookSourcePath(systemConfigPath)
  for (const [key, state] of trustEntries) {
    const parsed = parseTrustKey(key)
    if (!parsed || !state.trustedHash) {
      continue
    }
    if (!codexHookSourcePathsEqual(parsed.sourcePath, canonicalSystemConfigPath)) {
      continue
    }
    let hashes = trustedHashesByEvent.get(parsed.eventLabel)
    if (!hashes) {
      hashes = new Map()
      trustedHashesByEvent.set(parsed.eventLabel, hashes)
    }
    const enabled = state.enabled !== false
    // Why: Codex trust keys include hook indices, but the hash still proves the same event+command identity was approved after a reorder.
    if (enabled || !hashes.has(state.trustedHash)) {
      hashes.set(state.trustedHash, enabled)
    }
  }
  return trustedHashesByEvent
}
