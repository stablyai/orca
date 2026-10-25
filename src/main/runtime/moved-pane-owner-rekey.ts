import { agentHookServer } from '../agent-hooks/server'
import { forgetFailedAgentLaunches } from '../agent-launch/agent-launch-pane-attachment'
import type { Store } from '../persistence/loading-store/store'
import { makePaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import type { TerminalLeafMoveRequest } from '../../shared/terminal-leaf-move'
import type { OrcaRuntimeService } from './orca-runtime'

type PaneOwnerRuntime = Pick<OrcaRuntimeService, 'getExistingOrchestrationDb'> | undefined
type PaneAddress = { tabId: string; leafId: string }

/**
 * After a committed pane-key change: agent-status and orchestration keys follow the pane. A
 * failure is logged and the pane keeps that old key; returns false when either step failed.
 */
function rekeyPaneOwners(
  runtime: PaneOwnerRuntime,
  worktreeId: string,
  from: PaneAddress,
  to: PaneAddress,
  ptyId: string | null
): boolean {
  let moved = true
  const fromPaneKey = makePaneKey(from.tabId, from.leafId)
  const toPaneKey = makePaneKey(to.tabId, to.leafId)
  forgetFailedAgentLaunches(worktreeId, { kind: 'pane', ...from })
  try {
    // The process keeps the pane key baked into its env, so status must alias old to new.
    agentHookServer.transferPaneAuthority(fromPaneKey, toPaneKey, ptyId ?? undefined, Date.now(), {
      authorityVerified: true
    })
  } catch (error) {
    moved = false
    console.warn('[pty] moved pane kept its old agent-status key:', error)
  }
  try {
    runtime?.getExistingOrchestrationDb()?.rekeyWorkerTerminalResourcePaneKey({
      fromPaneKey,
      toPaneKey
    })
  } catch (error) {
    moved = false
    console.warn('[pty] moved pane kept its old orchestration resource key:', error)
  }
  return moved
}

/** After a committed move of a pane into a new tab: agent-status and orchestration keys follow. */
export function rekeyMovedPaneOwners(
  runtime: PaneOwnerRuntime,
  /** `ptyId` is the terminal the committed move bound the pane to. */
  request: TerminalLeafMoveRequest
): void {
  rekeyPaneOwners(
    runtime,
    request.worktreeId,
    { tabId: request.sourceTabId, leafId: request.leafId },
    { tabId: request.targetTabId, leafId: request.leafId },
    request.ptyId
  )
}

/** Layout-owner builds: main's one load-time repair, once this runtime can move pane owners. */
export async function repairDuplicatePtyPanesOnStart(
  store: Pick<Store, 'repairDuplicatePtyPanes'>,
  runtime: PaneOwnerRuntime
): Promise<void> {
  try {
    await store.repairDuplicatePtyPanes((move) => {
      const from = { tabId: move.tabId, leafId: move.removedLeafId }
      // The window's rule: a status owner that already moved to another tab stays there.
      const owner = parsePaneKey(
        agentHookServer.resolvePaneAuthorityOwner(makePaneKey(from.tabId, from.leafId))
      )
      if (owner && owner.tabId !== move.tabId) {
        return false
      }
      const to = { tabId: move.tabId, leafId: move.retainedLeafId }
      if (!rekeyPaneOwners(runtime, move.worktreeId, from, to, move.ptyId)) {
        throw new Error('pane_owner_transfer_failed')
      }
      return true
    })
  } catch (error) {
    console.warn('[persistence] duplicate-terminal pane repair was not written:', error)
  }
}
