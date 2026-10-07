import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries,
  type CodexEventLabel,
  type CodexHookTrustState
} from './config-toml-trust'
import {
  CODEX_EVENTS,
  CODEX_EVENT_LABEL,
  computeOrcaCodexHookHashes,
  getCodexConfigTomlPath,
  getConfigPath,
  getSystemCodexConfigTomlPath
} from './codex-hook-definition'
import { readEveryKnownCodexHookHashes } from './codex-hook-hash-lookup'
import { getSystemCodexHomePath } from './codex-home-paths'
import { readLedgerOrcaHashes } from './codex-managed-trust-reconciliation'
import {
  getRealHomeHookKeySourcePaths,
  getRealHomeHooksJsonPath
} from './codex-real-home-hooks-json'
import type { CodexHookHashes } from './codex-hook-trust-derivation'

/** One Codex home's hook files, and every path Codex may key its entries by. */
export type CodexHookHome = {
  homePath: string
  hooksJsonPath: string
  tomlPath: string
  keySourcePaths: readonly [string, ...string[]]
}

export function getManagedCodexHookHome(runtimeHomePath: string): CodexHookHome {
  const hooksJsonPath = getConfigPath(runtimeHomePath)
  return {
    homePath: runtimeHomePath,
    hooksJsonPath,
    tomlPath: getCodexConfigTomlPath(runtimeHomePath),
    keySourcePaths: [getCodexExplicitHomeHookSourcePath(hooksJsonPath)]
  }
}

/** ~/.codex, under every spelling Codex may key its entries by. */
export function getRealHomeCodexHookHome(): CodexHookHome {
  return {
    homePath: getSystemCodexHomePath(),
    hooksJsonPath: getRealHomeHooksJsonPath(),
    tomlPath: getSystemCodexConfigTomlPath(),
    keySourcePaths: getRealHomeHookKeySourcePaths()
  }
}

type CodexEventName = (typeof CODEX_EVENTS)[number]
type OrcaEntrySlot = { groupIndex: number; handlerIndex: number }
type OrcaEntryApproval = CodexHookTrustState & { key: string; trustedHash: string }

/** Where each event holds Orca's entry first. */
export function findOrcaEntrySlots(
  hooks: HooksConfig['hooks'],
  command: string
): Map<CodexEventName, OrcaEntrySlot> {
  return new Map(
    CODEX_EVENTS.flatMap((eventName) => {
      const definitions = Array.isArray(hooks?.[eventName]) ? hooks[eventName] : []
      const slot = definitions.flatMap((definition, groupIndex) =>
        (definition.hooks ?? []).flatMap((hook, handlerIndex) =>
          hook.command === command ? [{ groupIndex, handlerIndex }] : []
        )
      )[0]
      return slot ? [[eventName, slot] as const] : []
    })
  )
}

/** Per event, the approvals holding a hash at Orca's entry, one per spelling Codex keys it by. */
export function approvalsAtOrcaEntries(
  trustStates: ReadonlyMap<string, CodexHookTrustState>,
  slots: ReadonlyMap<CodexEventName, OrcaEntrySlot>,
  keySourcePaths: readonly string[],
  command: string
): Map<CodexEventLabel, OrcaEntryApproval[]> {
  return new Map(
    [...slots].map(([eventName, slot]) => {
      const eventLabel = CODEX_EVENT_LABEL[eventName]
      const approvals = keySourcePaths.flatMap((sourcePath) => {
        const key = computeTrustKey({ sourcePath, eventLabel, command, ...slot })
        const state = trustStates.get(key)
        return state?.trustedHash ? [{ ...state, key, trustedHash: state.trustedHash }] : []
      })
      return [eventLabel, approvals]
    })
  )
}

/**
 * Every hash Orca's entry may carry in `home`: Orca's own, every answer Codex
 * gave this Orca, and what main's grant recorded there. Keys are positional, so
 * an approval at Orca's key holding any other hash is a removed user hook's.
 */
export function readKnownOrcaHashes(home: CodexHookHome, command: string): CodexHookHashes[] {
  return [
    computeOrcaCodexHookHashes(command),
    ...readEveryKnownCodexHookHashes(),
    ...readLedgerOrcaHashes(home.homePath, command, MANAGED_HOOK_TIMEOUT_SECONDS)
  ]
}

/** The one rule for whether an approval's hash is Orca's. */
export function isKnownOrcaHash(
  knownOrcaHashes: readonly CodexHookHashes[],
  eventLabel: CodexEventLabel,
  trustedHash: string | undefined
): boolean {
  return (
    trustedHash !== undefined &&
    knownOrcaHashes.some((hashes) => hashes[eventLabel] === trustedHash)
  )
}

/** Until Codex answers: Orca's own hash, overlaid with each event's approval at Orca's entry holding a known Orca hash. */
export function readStopgapOrcaHashes(home: CodexHookHome, command: string): CodexHookHashes {
  let trustStates: ReadonlyMap<string, CodexHookTrustState>
  try {
    trustStates = readHookTrustEntries(home.tomlPath)
  } catch {
    trustStates = new Map()
  }
  return findStopgapOrcaHashes({
    trustStates,
    hooks: readHooksJson(home.hooksJsonPath)?.hooks,
    keySourcePaths: home.keySourcePaths,
    command,
    knownOrcaHashes: readKnownOrcaHashes(home, command)
  })
}

/** `readStopgapOrcaHashes` over files already read, counting only `knownOrcaHashes`. */
export function findStopgapOrcaHashes(found: {
  trustStates: ReadonlyMap<string, CodexHookTrustState>
  hooks: HooksConfig['hooks']
  keySourcePaths: readonly string[]
  command: string
  knownOrcaHashes: readonly CodexHookHashes[]
}): CodexHookHashes {
  const slots = findOrcaEntrySlots(found.hooks, found.command)
  const approvals = approvalsAtOrcaEntries(
    found.trustStates,
    slots,
    found.keySourcePaths,
    found.command
  )
  return {
    ...computeOrcaCodexHookHashes(found.command),
    ...Object.fromEntries(
      [...approvals].flatMap(([eventLabel, held]) => {
        // Why a known hash also holds for a rewritten copy: Codex hashes content, not position.
        const approval = held.find(({ trustedHash }) =>
          isKnownOrcaHash(found.knownOrcaHashes, eventLabel, trustedHash)
        )
        return approval ? [[eventLabel, approval.trustedHash]] : []
      })
    )
  }
}
