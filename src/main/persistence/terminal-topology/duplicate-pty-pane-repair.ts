import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '../../../shared/terminal-layout-pty-ownership'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../loading-store/store-runtime-state'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { findWorktreeIdForTab } from '../restoring-sessions/pane-identity-migration'
import { writeRestorable } from './restorable-write'
import {
  moveRecordKey,
  rekeyPaneProfileRecords,
  writeRekeyedProfileRecords
} from './terminal-leaf-move'
import { keepFrozen, type TerminalTopologyCommitContext } from './terminal-topology-commit'
import { assignWorkspaceSessionPartition } from './terminal-topology-membership'

/** A pane the repair drops, and the pane of the same tab that keeps its terminal. */
export type DuplicatePtyPaneTransfer = {
  worktreeId: string
  tabId: string
  removedLeafId: string
  retainedLeafId: string
  ptyId: string
}

function boundByOtherTab(session: WorkspaceSessionState, tabId: string, ptyId: string): boolean {
  return Object.entries(session.terminalLayoutsByTabId ?? {}).some(
    ([otherTabId, layout]) =>
      otherTabId !== tabId && Object.values(layout?.ptyIdsByLeafId ?? {}).includes(ptyId)
  )
}

/** The partition with one pane per terminal, and the owner transfers that implies; null when none. */
export function planDuplicatePtyPaneRepair(
  session: WorkspaceSessionState,
  /** A workspace whose stored session must stay as it is (a paused WSL move). */
  isFrozen: (worktreeId: string) => boolean = () => false
): { session: WorkspaceSessionState; transfers: DuplicatePtyPaneTransfer[] } | null {
  let layouts: Record<string, TerminalLayoutSnapshot> | null = null
  const transfers: DuplicatePtyPaneTransfer[] = []
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const repaired = normalizeTerminalLayoutPtyOwnership(layout)
    const worktreeId = findWorktreeIdForTab(session, tabId)
    // The write keeps a frozen workspace's stored tree, so its owners must not move either.
    if (!repaired.changed || (worktreeId && isFrozen(worktreeId))) {
      continue
    }
    layouts ??= { ...session.terminalLayoutsByTabId }
    layouts[tabId] = repaired.snapshot
    for (const transfer of resolveTerminalLayoutPtyOwnershipTransfers(layout, repaired.snapshot)) {
      // The window's transfer guards: only pane keys that parse, and no terminal another tab binds.
      if (
        worktreeId &&
        !tabId.includes(':') &&
        isTerminalLeafId(transfer.removedLeafId) &&
        isTerminalLeafId(transfer.retainedLeafId) &&
        !boundByOtherTab(session, tabId, transfer.ptyId)
      ) {
        transfers.push({ worktreeId, tabId, ...transfer })
      }
    }
  }
  return layouts ? { session: { ...session, terminalLayoutsByTabId: layouts }, transfers } : null
}

/** The dropped pane's sleep record and incarnation follow it, as the window's transfer moves them. */
function rekeyPaneSessionRecords(
  session: WorkspaceSessionState,
  move: DuplicatePtyPaneTransfer
): WorkspaceSessionState {
  const from = makePaneKey(move.tabId, move.removedLeafId)
  const to = makePaneKey(move.tabId, move.retainedLeafId)
  return {
    ...session,
    // Both panes name one terminal, so the kept pane's own incarnation wins.
    terminalPtyIncarnationsByPaneKey: moveRecordKey(
      session.terminalPtyIncarnationsByPaneKey,
      from,
      to,
      undefined,
      true
    ),
    sleepingAgentSessionsByPaneKey: moveRecordKey(
      session.sleepingAgentSessionsByPaneKey,
      from,
      to,
      (record) => ({ ...record, paneKey: to })
    )
  }
}

/**
 * Repairs every non-runtime partition holding a terminal in two panes of one tab. Every transfer
 * runs before the write, so disk never drops a pane key whose owners have not moved yet. `transfer`
 * returns false for a pane whose owner is not this tab's to move (its records stay), and throws
 * when a move failed, which skips the write so the next start retries.
 */
export function repairDuplicatePtyPanesMutation(
  context: TerminalTopologyCommitContext,
  transfer: (move: DuplicatePtyPaneTransfer) => boolean
): () => DurableProfileStateMutation<number> {
  return () => {
    const plans = context
      .hostIds()
      // A paired server's partition is a display copy of that server's own layout.
      .filter((hostId) => !hostId.startsWith('runtime:'))
      .flatMap((hostId: ExecutionHostId) => {
        const plan = planDuplicatePtyPaneRepair(
          context.getSession(hostId),
          (worktreeId) =>
            hostId === LOCAL_EXECUTION_HOST_ID && isWslMoveWorkspaceSessionFrozen(worktreeId)
        )
        return plan ? [{ hostId, ...plan }] : []
      })
    if (plans.length === 0) {
      return { value: 0, persist: false }
    }
    let moved: Set<DuplicatePtyPaneTransfer>
    try {
      moved = new Set(plans.flatMap((plan) => plan.transfers.filter(transfer)))
    } catch (error) {
      console.warn('[persistence] duplicate-terminal pane repair skipped:', error)
      return { value: 0, persist: false }
    }
    const restores = plans.map(({ hostId, session, transfers }) =>
      writeRestorable(
        () => context.getSession(hostId),
        (value) => context.markDirty(assignWorkspaceSessionPartition(context.state, hostId, value)),
        keepFrozen(
          hostId,
          transfers.filter((move) => moved.has(move)).reduce(rekeyPaneSessionRecords, session),
          context
        )
      )
    )
    for (const move of moved) {
      restores.push(
        ...writeRekeyedProfileRecords(
          rekeyPaneProfileRecords(
            context.state,
            { tabId: move.tabId, leafId: move.removedLeafId },
            { tabId: move.tabId, leafId: move.retainedLeafId }
          ),
          context
        )
      )
    }
    return {
      value: plans.length,
      // Latest write first: a restore only undoes a value no later write replaced.
      rollback: () => {
        for (let index = restores.length - 1; index >= 0; index -= 1) {
          restores[index]?.()
        }
      }
    }
  }
}
