import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence/loading-store/store'
import type { AdoptStablePaneArgs, AdoptStablePaneResult } from '../ipc/spawn-types'
import { isClosedPaneFenced } from '../../../persistence/terminal-topology/closed-pane-binding-fence'
import { hasClosedTerminalTabRecord } from '../../../../shared/workspace-layout/closed-terminal-tab-tombstones'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { ptyIncarnationById } from '../provider/ownership-state'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { paneSpawnReservationsByOwnerKey } from './spawn-reservation'
import { resolveStablePaneOwner } from './stable-owner'
import { assertPaneStillExists, type PaneSpawnOperation } from './pane-spawn-operation'
/** An observed exit needs the same surface and acquisition, rather than a now-retired live owner. */
export function consumeExitedPaneOperation(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  args: Pick<AdoptStablePaneArgs, 'worktreeId' | 'connectionId' | 'tabId' | 'leafId' | 'renderer'>,
  operation: PaneSpawnOperation
): AdoptStablePaneResult {
  const acquisition = operation.acquisition
  const outcome = acquisition?.reservation.outcome
  if (!acquisition || outcome?.kind !== 'registration-exited') {
    throw new Error('terminal_pane_owner_changed')
  }
  const successor = paneSpawnReservationsByOwnerKey.get(
    acquisition.reservation.ownerKey ?? acquisition.key
  )
  const incarnation = ptyIncarnationById.get(outcome.result.id)
  const owner = resolveStablePaneOwner(
    runtime,
    store,
    makePaneKey(args.tabId, args.leafId),
    args.worktreeId,
    args.connectionId
  )
  if (
    (successor && successor !== acquisition.reservation) ||
    (incarnation && outcome.result.incarnationId && incarnation !== outcome.result.incarnationId) ||
    (owner &&
      (owner.ptyId !== outcome.result.id || owner.incarnationId !== outcome.result.incarnationId))
  ) {
    throw new Error('terminal_pane_owner_changed')
  }
  if (args.renderer && args.worktreeId) {
    const session = store?.getWorkspaceSession(
      args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
    )
    if (
      acquisition.surfaceWithdrawn ||
      isClosedPaneFenced(makePaneKey(args.tabId, args.leafId)) ||
      hasClosedTerminalTabRecord(session?.closedTerminalTabTombstonesByTabId, args.tabId)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (!runtime?.hasTerminalPaneView?.(args.worktreeId, args.tabId, args.leafId)) {
      assertPaneStillExists(store, args.worktreeId, args.tabId, args.leafId, args.connectionId)
    }
  }
  return {
    operation,
    outcome,
    result: outcome.result,
    owner: { ptyId: outcome.result.id, tabId: args.tabId, leafId: args.leafId },
    materialized: true
  }
}
