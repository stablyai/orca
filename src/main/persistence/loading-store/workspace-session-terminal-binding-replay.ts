import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { SessionUnitReader } from '../../../shared/session-unit-reader'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../shared/terminal-execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { preserveMissingLeafRecordEntries } from '../restoring-sessions/terminal-layout-normalization'

import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'

type TerminalBindingRecovery = Pick<
  TerminalBindingRecoveryOperations,
  | 'getTerminalLayoutLeafIds'
  | 'getConnectionIdForWorktree'
  | 'isRestorablePtyBinding'
  | 'hasRestorableSshRemotePtyLease'
>

export type WorkspaceSessionTerminalBindingReplayOptions = {
  targetIdForWorktree?: (worktreeId: string) => string | null
  executionHostId?: ExecutionHostId
}

function ptyBindingMatchesExecutionHost(
  ptyId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  if (!executionHostId || executionHostId === LOCAL_EXECUTION_HOST_ID) {
    return true
  }
  const owner = getPtyExecutionHost(ptyId)
  // Unscoped legacy IDs still need lease/context checks; known foreign IDs cannot cross hosts.
  return owner === null || owner === executionHostId
}

/** Recover stale empty maps unless retirement proves a close; partial maps need live SSH lease proof. */
export function preserveMissingWorkspaceSessionTerminalBindings(
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  bindingRecovery: TerminalBindingRecovery,
  options: WorkspaceSessionTerminalBindingReplayOptions = {}
): WorkspaceSessionState {
  if (!prior) {
    return session
  }

  const reader = SessionUnitReader.between(prior, session, new SessionUnitIndex(prior))
  reduceMissingSessionTerminalBindings(
    reader,
    Object.keys(session.tabsByWorktree ?? {}),
    Object.keys(session.terminalLayoutsByTabId ?? {}),
    bindingRecovery,
    options
  )
  return reader.snapshot()
}

/** The same tab/owner kernels serve full ingress and indexed incremental admissions. */
export function reduceMissingSessionTerminalBindings(
  reader: SessionUnitReader,
  owners: Iterable<string>,
  tabIds: Iterable<string>,
  bindingRecovery: TerminalBindingRecovery,
  options: WorkspaceSessionTerminalBindingReplayOptions = {}
): void {
  const ambiguous = (tabId: string): boolean =>
    reader.terminalOccurrenceCount(tabId, 'prior') > 1 || reader.terminalOccurrenceCount(tabId) > 1
  const targetIdForWorktree =
    options.targetIdForWorktree ??
    ((owner: string) => bindingRecovery.getConnectionIdForWorktree(owner))
  for (const owner of owners) {
    const priorList = reader.unit('tabsByWorktree', owner, 'prior').value
    const tabs = reader.unit('tabsByWorktree', owner).value
    if (!priorList || !tabs) {
      continue
    }
    let priorById: Map<string, (typeof priorList)[number]> | undefined
    const next = tabs.map((tab) => {
      if (tab.ptyId || ambiguous(tab.id)) {
        return tab
      }
      priorById ??= new Map(priorList.map((row) => [row.id, row]))
      const priorTab = priorById.get(tab.id)
      const incomingLayout = reader.unit('terminalLayoutsByTabId', tab.id).value
      const priorLayout = reader.unit('terminalLayoutsByTabId', tab.id, 'prior').value
      const priorLeaf = Object.entries(priorLayout?.ptyIdsByLeafId ?? {}).find(
        ([, pty]) => pty === priorTab?.ptyId
      )?.[0]
      const removed =
        incomingLayout !== undefined &&
        priorLeaf !== undefined &&
        !bindingRecovery.getTerminalLayoutLeafIds(incomingLayout.root).has(priorLeaf)
      return priorTab?.ptyId &&
        !removed &&
        ptyBindingMatchesExecutionHost(priorTab.ptyId, options.executionHostId) &&
        bindingRecovery.isRestorablePtyBinding({
          ptyId: priorTab.ptyId,
          worktreeId: owner,
          targetId: targetIdForWorktree(owner),
          tabId: tab.id
        })
        ? { ...tab, ptyId: priorTab.ptyId }
        : tab
    })
    if (next.some((tab, i) => tab !== tabs[i])) {
      reader.write('tabsByWorktree', owner, { present: true, value: next })
    }
  }
  for (const tabId of tabIds) {
    const layout = reader.unit('terminalLayoutsByTabId', tabId).value
    const priorLayout = reader.unit('terminalLayoutsByTabId', tabId, 'prior').value
    if (!layout || !priorLayout?.ptyIdsByLeafId || ambiguous(tabId)) {
      continue
    }
    const incoming = layout.ptyIdsByLeafId ?? {}
    const hasBinding = Object.keys(incoming).length > 0
    const liveLeaves = bindingRecovery.getTerminalLayoutLeafIds(layout.root)
    const owner = reader.replayTerminalOwner(tabId)
    const targetId = owner ? targetIdForWorktree(owner) : null
    const restored = Object.fromEntries(
      Object.entries(priorLayout.ptyIdsByLeafId).filter(
        ([leafId, ptyId]) =>
          liveLeaves.has(leafId) &&
          incoming[leafId] === undefined &&
          ptyBindingMatchesExecutionHost(ptyId, options.executionHostId) &&
          (hasBinding
            ? bindingRecovery.hasRestorableSshRemotePtyLease({
                ptyId,
                targetId,
                worktreeId: owner,
                tabId,
                leafId
              })
            : bindingRecovery.isRestorablePtyBinding({
                ptyId,
                targetId,
                worktreeId: owner,
                tabId,
                leafId
              }))
      )
    )
    if (!Object.keys(restored).length) {
      continue
    }
    const next = { ...layout, ptyIdsByLeafId: { ...restored, ...incoming } }
    for (const field of ['buffersByLeafId', 'scrollbackRefsByLeafId', 'titlesByLeafId'] as const) {
      const kept = preserveMissingLeafRecordEntries(priorLayout[field], layout[field], liveLeaves)
      if (kept) {
        next[field] = kept
      }
    }
    reader.write('terminalLayoutsByTabId', tabId, { present: true, value: next })
  }
}

export function sshTargetIdForWorkspaceSessionHost(
  hostId: ExecutionHostId
): ((worktreeId: string) => string | null) | undefined {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return undefined
  }
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'ssh' ? () => parsed.targetId : () => null
}
