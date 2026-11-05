import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { RuntimeStore } from '../../runtime-store-contract'

/** Explicit resume edits use the same owner as sleep/wake; session snapshots retain only unplaced recovery records. */
export async function commitCanonicalResumeRecordEdit(
  store: RuntimeStore | undefined,
  hostId: ExecutionHostId,
  edit: (session: WorkspaceSessionState) => WorkspaceSessionState | Error | null
): Promise<void> {
  if (
    !store?.workspaceSurfacesInitialized?.(hostId) ||
    !store.applyLayoutCommand ||
    !store.getWorkspaceSession
  ) {
    return
  }
  const before = structuredClone(store.getWorkspaceSession(hostId))
  const after = edit(structuredClone(before))
  if (after instanceof Error) {
    throw after
  }
  if (!after) {
    return
  }
  const previous = before.sleepingAgentSessionsByPaneKey ?? {}
  const next = after.sleepingAgentSessionsByPaneKey ?? {}
  const changes = new Map<string, { paneKey: string; record?: SleepingAgentSessionRecord }[]>()
  for (const paneKey of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (isDeepStrictEqual(previous[paneKey], next[paneKey])) {
      continue
    }
    const record = next[paneKey] ?? previous[paneKey]!
    const pane = parsePaneKey(paneKey)
    if (!pane || !before.tabsByWorktree[record.worktreeId]?.some((tab) => tab.id === pane.tabId)) {
      continue
    }
    const key = JSON.stringify([record.worktreeId, next[paneKey] ? 'sleep' : 'wake'])
    changes.set(key, [...(changes.get(key) ?? []), { paneKey, record: next[paneKey] }])
  }
  for (const entries of changes.values()) {
    const paneKeys = entries.map((entry) => entry.paneKey)
    const workspace = (entries[0]!.record ?? previous[entries[0]!.paneKey]!).worktreeId
    const records = entries.flatMap((entry) => entry.record ?? [])
    const expectedRecords = Object.fromEntries(paneKeys.map((key) => [key, previous[key] ?? null]))
    const command = records.length
      ? {
          type: 'sleep' as const,
          workspace,
          paneKeys,
          records,
          recordOnly: true as const,
          expectedRecords
        }
      : { type: 'wake' as const, workspace, paneKeys, recordOnly: true as const, expectedRecords }
    const outcome = await store.applyLayoutCommand(command, [hostId])
    if (!outcome.ok) {
      throw new Error('Terminal resume information changed before it could be saved. Try again.')
    }
  }
}
