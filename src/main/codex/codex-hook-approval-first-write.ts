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
 * Approve before writing entries; on failure, restore only our approvals without installed entries.
 * Preserve other writers' changes. Refuse unloadable TOML before writing anything.
 */
export function writeCodexHookApprovalsBeforeEntries(
  tomlPath: string,
  approvals: readonly CodexTrustEntry[],
  writeEntries: () => void,
  hooksJsonPath: string
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
    rollBackCodexHookApprovals(tomlPath, changed, before, hooksJsonPath)
    throw error
  }
}

function rollBackCodexHookApprovals(
  tomlPath: string,
  changed: readonly CodexTrustEntry[],
  before: ReadonlyMap<string, readonly string[]>,
  hooksJsonPath: string
): void {
  try {
    const current = readHookTrustEntries(tomlPath)
    const ours = changed.filter((entry) => {
      const state = current.get(computeTrustKey(entry))
      return (
        !holdsEntryAtApprovedSlot(hooksJsonPath, entry) &&
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

function holdsEntryAtApprovedSlot(hooksJsonPath: string, approval: CodexTrustEntry): boolean {
  const definitions =
    readHooksJson(hooksJsonPath)?.hooks?.[CODEX_EVENT_NAME_BY_LABEL[approval.eventLabel]]
  const hook = Array.isArray(definitions)
    ? definitions[approval.groupIndex]?.hooks?.[approval.handlerIndex]
    : undefined
  return hook?.command === approval.command
}
