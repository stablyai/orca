import { readHooksJson } from '../agent-hooks/installer-utils'
import { CODEX_EVENT_NAME_BY_LABEL } from './codex-hook-identity'
import {
  computeTrustKey,
  readHookTrustBlocks,
  readHookTrustEntries,
  readHookTrustKeySpellings,
  restoreHookTrustBlocks,
  upsertHookTrustEntries,
  type CodexTrustEntry
} from './config-toml-trust'

/** The approvals among `approvals` that config.toml does not already hold as given, under every key spelling. */
export function findMissingCodexHookApprovals(
  approvals: readonly CodexTrustEntry[],
  tomlPath: string
): CodexTrustEntry[] {
  const trustStates = readHookTrustEntries(tomlPath)
  const spelled = readHookTrustKeySpellings(tomlPath)
  return approvals.filter((entry) => {
    const key = computeTrustKey(entry)
    const state = trustStates.get(key)
    return (
      !spelled(key) ||
      state === undefined ||
      state.trustedHash !== entry.trustedHash ||
      state.enabled !== entry.enabled
    )
  })
}

/**
 * Writes Orca's approvals, then its entries through `writeEntries`. When that
 * throws, an approval goes back to its prior tables only if its entry is not in
 * the hooks file and the approval still reads as this call wrote it, so another
 * writer's change is never overwritten. The error is rethrown. Throws
 * CodexConfigTomlRefusedError, writing nothing, when Codex could not load the result.
 */
export function writeCodexHookApprovalsBeforeEntries(
  tomlPath: string,
  approvals: readonly CodexTrustEntry[],
  writeEntries: () => void,
  holdsEntry: (approval: CodexTrustEntry) => boolean
): void {
  const changed = findMissingCodexHookApprovals(approvals, tomlPath)
  const before = readHookTrustBlocks(
    tomlPath,
    changed.map((entry) => computeTrustKey(entry))
  )
  upsertHookTrustEntries(tomlPath, changed)
  try {
    writeEntries()
  } catch (error) {
    rollBackCodexHookApprovals(tomlPath, changed, before, holdsEntry)
    throw error
  }
}

function rollBackCodexHookApprovals(
  tomlPath: string,
  changed: readonly CodexTrustEntry[],
  before: ReadonlyMap<string, readonly string[]>,
  holdsEntry: (approval: CodexTrustEntry) => boolean
): void {
  try {
    const current = readHookTrustEntries(tomlPath)
    const ours = changed.filter((entry) => {
      const state = current.get(computeTrustKey(entry))
      return (
        !holdsEntry(entry) &&
        state !== undefined &&
        state.trustedHash === entry.trustedHash &&
        state.enabled === entry.enabled
      )
    })
    restoreHookTrustBlocks(
      tomlPath,
      ours.map((entry) => {
        const key = computeTrustKey(entry)
        return { key, blocks: before.get(key) ?? [] }
      })
    )
  } catch (error) {
    console.warn('[codex-hook-approvals] could not take back hook approvals:', error)
  }
}

/** Whether `hooksJsonPath` holds the approved command at the approval's slot, read when asked. */
export function readsEntryAtApprovedSlot(
  hooksJsonPath: string
): (approval: CodexTrustEntry) => boolean {
  return (approval) => {
    const definitions =
      readHooksJson(hooksJsonPath)?.hooks?.[CODEX_EVENT_NAME_BY_LABEL[approval.eventLabel]]
    const hook = Array.isArray(definitions)
      ? definitions[approval.groupIndex]?.hooks?.[approval.handlerIndex]
      : undefined
    return hook?.command === approval.command
  }
}
