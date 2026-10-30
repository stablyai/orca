import type { PtySpawnOutcome } from '../spawn-outcome'
import { isClosedPaneFenced } from '../../../persistence/terminal-topology/closed-pane-binding-fence'
import { hasClosedTerminalTabRecord } from '../../../../shared/closed-terminal-tab-tombstones'
import {
  toSshExecutionHostId,
  getConnectionExecutionHostId
} from '../../../../shared/execution-host'
import { ptyIncarnationById } from '../provider/ownership-state'
import { reconcilePaneOwner } from './stable-pane-attach'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { Store } from '../../../persistence'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getProvider } from '../provider/registry'
import {
  joinPaneSpawn,
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey,
  reservePaneSpawn,
  resolvePaneSpawnReservation,
  rejectPaneSpawnReservation
} from './spawn-reservation'
import { resolveStablePaneOwner } from './stable-owner'
import { completePaneAdoption } from './complete-pane-adoption'
import {
  assertPaneStillExists,
  type AbsentPaneBinding,
  type PaneSpawnOperation
} from './pane-spawn-operation'
import type { AdoptStablePaneArgs, AdoptStablePaneResult } from '../ipc/spawn-types'

/** Owns attachment through publication, including the lazy fresh path, under one reservation. */
export async function adoptStablePane(
  runtime: OrcaRuntimeService | undefined,
  store: Store | undefined,
  args: AdoptStablePaneArgs
): Promise<AdoptStablePaneResult | null> {
  if (args.signal?.aborted) {
    throw new Error('client_disconnected')
  }
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const key = makePaneSpawnReservationKey(args.worktreeId, args.connectionId, paneKey)!
  const resolveOwner = () => {
    const owner = resolveStablePaneOwner(
      runtime,
      store,
      paneKey,
      args.worktreeId,
      args.connectionId
    )
    return owner?.ptyId === args.stoppedPtyId ? null : owner
  }
  let remaining = 1
  if (args.completed?.outcome?.kind === 'registration-exited') {
    if (!args.completed.operation) {
      throw new Error('terminal_pane_owner_changed')
    }
    return consumeExitedPaneOperation(runtime, store, args, args.completed.operation)
  }
  if (args.completed?.materialized) {
    const owner = resolveOwner()
    if (!owner) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (args.worktreeId && typeof store?.getWorkspaceSession === 'function') {
      assertPaneStillExists(store, args.worktreeId, args.tabId, args.leafId, args.connectionId)
    }
    if (
      owner.ptyId === args.completed.result.id &&
      owner.incarnationId === args.completed.result.incarnationId
    ) {
      return args.completed
    }
    remaining = 0
  }
  let reservation = args.reservation
  if (!reservation) {
    for (;;) {
      const pending = paneSpawnReservationsByOwnerKey.get(key)
      if (!pending) {
        reservation = reservePaneSpawn(key)
        break
      }
      const joined = await joinPaneSpawn(pending)
      if (args.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      if (!joined) {
        continue
      }
      if (pending.outcome?.kind === 'registration-exited') {
        const operation = pending.operation!
        const exited = consumeExitedPaneOperation(runtime, store, args, operation)
        args.onOutcome?.(pending.outcome, operation)
        return exited
      }
      if (!args.worktreeId) {
        const successor = paneSpawnReservationsByOwnerKey.get(key)
        if (successor && successor !== pending) {
          if (remaining-- <= 0) {
            throw new Error('terminal_pane_owner_changed')
          }
          continue
        }
        const incarnation = ptyIncarnationById.get(joined.id)
        if (
          joined.incarnationId !== undefined &&
          incarnation !== undefined &&
          incarnation !== joined.incarnationId
        ) {
          throw new Error('terminal_pane_owner_changed')
        }
        return {
          result: { ...joined, isReattach: true },
          owner: { ptyId: joined.id, tabId: args.tabId, leafId: args.leafId },
          materialized: true
        }
      }
      const owner = resolveOwner()
      if (!owner) {
        throw new Error('terminal_pane_owner_changed')
      }
      if (args.worktreeId && typeof store?.getWorkspaceSession === 'function') {
        assertPaneStillExists(store, args.worktreeId, args.tabId, args.leafId, args.connectionId)
      }
      if (owner.ptyId === joined.id && owner.incarnationId === joined.incarnationId) {
        return { result: { ...joined, isReattach: true }, owner, materialized: true }
      }
      if (remaining-- <= 0) {
        throw new Error('terminal_pane_owner_changed')
      }
      // Recheck after the await; a new holder may already have reserved the pane.
    }
  }
  const settle = (outcome: PtySpawnOutcome, operation: PaneSpawnOperation) => {
    if (reservation.outcome) {
      return
    }
    reservation.outcome = outcome
    reservation.operation = operation
    resolvePaneSpawnReservation(key, reservation, outcome.result)
    args.onOutcome?.(outcome, operation)
  }
  let mustExist = false
  let absentOwner: AbsentPaneBinding | undefined
  try {
    if (args.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    return await reconcilePaneOwner<AdoptStablePaneResult | null>({
      owner: resolveOwner(),
      resolveOwner,
      losses: 1 - remaining,
      attach: async (owner) => {
        if (!args.worktreeId) {
          throw new Error('terminal_pane_owner_changed')
        }
        mustExist = true
        absentOwner = undefined
        if (args.worktreeId && typeof store?.getWorkspaceSession === 'function') {
          assertPaneStillExists(store, args.worktreeId, args.tabId, args.leafId, args.connectionId)
        }
        const adopted = await completePaneAdoption({
          runtime,
          store,
          owner,
          worktreeId: args.worktreeId,
          connectionId: args.connectionId,
          provider: getProvider(getConnectionExecutionHostId(args.connectionId)),
          spawnOptions: { cols: args.cols, rows: args.rows, cwd: args.cwd, signal: args.signal },
          resolveOwner,
          preAllocatedHandle: args.preAllocatedHandle,
          keepAbsentBinding: args.keepAbsentBinding,
          attachOnlyView: args.attachOnlyView
        })
        if (adopted) {
          const operation: PaneSpawnOperation = {
            mustExist,
            acquisition: { key, reservation, settle: (outcome) => settle(outcome, operation) }
          }
          if (adopted.outcome.kind !== 'registration-exited') {
            args.onAdopted?.(adopted.result)
          }
          settle(adopted.outcome, operation)
          return { ...adopted, operation }
        }
        absentOwner = {
          ptyId: owner.ptyId,
          incarnationIds: [owner.runtimeIncarnationId, owner.persistedIncarnationId].filter(
            (id): id is string => id !== undefined
          )
        }
        return adopted
      },
      fresh: async () => {
        if (args.signal?.aborted) {
          throw new Error('client_disconnected')
        }
        if (mustExist && args.worktreeId) {
          assertPaneStillExists(store, args.worktreeId, args.tabId, args.leafId, args.connectionId)
        }
        if (!args.spawnFresh) {
          rejectPaneSpawnReservation(key, reservation, new Error('terminal_pane_unbound'))
          return null
        }
        const operation: PaneSpawnOperation = {
          mustExist,
          ...(absentOwner ? { absentOwner } : {}),
          acquisition: { key, reservation, settle: (outcome) => settle(outcome, operation) }
        }
        const result = await args.spawnFresh(operation)
        settle(
          {
            kind: result.agentSessionEnsure?.disposition === 'adopted' ? 'adopted' : 'committed',
            result
          },
          operation
        )
        return null
      }
    })
  } catch (error) {
    rejectPaneSpawnReservation(key, reservation, error)
    throw error
  }
}

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
  const successor = paneSpawnReservationsByOwnerKey.get(acquisition.key)
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
