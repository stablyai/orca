import type { PaneSpawnOperation } from './pane/pane-spawn-operation'
import type { AdoptStablePaneArgs } from './ipc/spawn-types'
import { adoptedOutcome, type PtySpawnOutcome } from './spawn-outcome'
import type { PtySpawnOperationState, PtySpawnExecutionFacts } from './spawn-operation-state'
import { beginPtySpawn, reportPtyPaneAdoption } from './spawn-begin'
import { executePtySpawn } from './spawn-execute'
import { resolveEarlyPaneKey, resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { consumeExitedPaneOperation } from './pane/adopt-stable'
import { attachOnlyViewOf } from './pane/attach-only-view'
import {
  pendingRuntimePaneCreatesByOwnerKey,
  rejectPaneSpawnReservation,
  reserveIdlePaneSpawn
} from './pane/spawn-reservation'
import { restoreProvisionalPtySize } from './spawn-options-assembly'
import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { releaseStoppedPaneBinding } from './pane/pane-owner-replacement'

type SpawnAdapter<State extends PtySpawnOperationState> = {
  state: State
  prepare: () => Promise<void>
  commit: () => Promise<PtySpawnOutcome>
  facts: () => PtySpawnExecutionFacts
  admission?: Promise<void>
  beforeExecute?: () => void
  onCommitted?: () => void
  onOutcome?: (outcome: PtySpawnOutcome) => void
  onError?: (error: unknown) => unknown
  releasePreparation?: () => void
  releaseHiddenMark?: () => void
  adoption?: () => Pick<AdoptStablePaneArgs, 'renderer' | 'keepAbsentBinding' | 'completed'>
  replace?: () => Promise<void>
}

export function normalizePtySpawnSessionId(sessionId: string | undefined): string | undefined {
  return typeof sessionId === 'string' ? sessionId.trim() || undefined : undefined
}

function cancelRegistration(ctx: PtySpawnOperationState): void {
  if (ctx.pendingRegistrationPtyId) {
    ctx.deps.runtime?.cancelPendingPtyRegistration?.(
      ctx.pendingRegistrationPtyId,
      ctx.rejectedRegistrationCandidate?.incarnationId,
      ctx.pendingRegistrationClaim
    )
    ctx.pendingRegistrationPtyId = null
  }
}

function retirePreparation<State extends PtySpawnOperationState>(
  adapter: SpawnAdapter<State>,
  reattachId?: string
): void {
  const ctx = adapter.state
  adapter.releasePreparation?.()
  restoreProvisionalPtySize(ctx, { reattachId })
  ctx.finishTerminalInstall()
  ctx.finishTerminalInstall = () => {}
  ctx.releaseWorktreeSpawn?.()
  ctx.releaseWorktreeSpawn = undefined
}

/** One host operation owns preparation, dispatch, settlement and cleanup for every start entry. */
export async function runPtySpawn<State extends PtySpawnOperationState>(
  adapter: SpawnAdapter<State>
): Promise<PtySpawnOutcome> {
  const ctx = adapter.state
  const args = ctx.args
  ctx.preAdoptedStablePane = args.adoptedStablePane ?? null
  ctx.paneSpawnOperation = args.paneSpawnOperation
  const replacementKey = adapter.replace ? resolveEarlyPaneSpawnReservationKey(args) : null
  if (replacementKey) {
    ctx.paneSpawnReservation = await reserveIdlePaneSpawn(replacementKey)
    ctx.paneSpawnReservationKey = replacementKey
  }
  let prepared = false
  const finish = (outcome: PtySpawnOutcome) => {
    ctx.paneSpawnOperation?.acquisition?.settle(outcome)
    if (outcome.kind === 'registration-exited') {
      adapter.releasePreparation?.()
      adapter.releaseHiddenMark?.()
    }
    adapter.onOutcome?.(outcome)
    return outcome
  }
  const complete = async (operation: PaneSpawnOperation): Promise<PtySpawnOutcome> => {
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
    const runtime = ctx.deps.runtime
    const acquire = runtime?.acquireWorktreeTerminalSpawn
    ctx.releaseWorktreeSpawn = acquire
      ? await acquire.call(runtime, spawnWorktreeTarget(args.worktreeId, args.connectionId), {
          refuseSleptWorktree: args.refuseSleptWorktree,
          reattachSessionId: ctx.preAdoptedStablePane?.owner.ptyId ?? args.sessionId,
          requireAttachOnly: () => {
            ctx.spawnOptions = { ...ctx.spawnOptions, attachOnly: true }
          }
        })
      : undefined
    adapter.beforeExecute?.()
    await executePtySpawn(ctx, adapter.facts())
    const outcome = finish(await adapter.commit())
    // Runtime hidden P2 follows the awaited prompt-intent wrapper and never an exited result.
    if (outcome.kind !== 'registration-exited') {
      adapter.onCommitted?.()
    }
    return outcome
  }
  const acquire = async (
    paneKey: string,
    fresh: (operation: PaneSpawnOperation) => Promise<PtySpawnOutcome>
  ) => {
    const pane = parsePaneKey(paneKey)!
    let outcome: PtySpawnOutcome | undefined
    const adopted = await ctx.deps.adoptStablePane({
      ...adapter.adoption?.(),
      cols: args.cols,
      rows: args.rows,
      cwd: ctx.cwd,
      worktreeId: args.worktreeId,
      connectionId: args.connectionId,
      ...pane,
      signal: args.signal,
      preAllocatedHandle: adapter.facts().preAllocatedHandle ?? undefined,
      reservation: ctx.paneSpawnReservation ?? undefined,
      stoppedPtyId: adapter.facts().replacedPaneOwner?.ptyId,
      attachOnlyView: attachOnlyViewOf(args),
      spawnFresh: async (operation) => {
        outcome = await fresh(operation)
        return outcome.result
      }
    })
    if (!adopted) {
      return outcome!
    }
    if (prepared) {
      retirePreparation(adapter, adopted.result.id)
    }
    adapter.releaseHiddenMark?.()
    reportPtyPaneAdoption(ctx, adopted)
    return finish(adoptedOutcome(adopted))
  }
  const fresh = async (operation: PaneSpawnOperation): Promise<PtySpawnOutcome> => {
    if (prepared) {
      retirePreparation(adapter)
    }
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
    prepared = true
    await adapter.prepare()
    const latePane =
      !resolveEarlyPaneKey(args) && !operation.acquisition ? adapter.facts().paneKey : null
    if (latePane) {
      const pending = ctx.paneSpawnReservationKey
        ? pendingRuntimePaneCreatesByOwnerKey.get(ctx.paneSpawnReservationKey)
        : undefined
      if (pending) {
        await pending.promise
        const pane = parsePaneKey(latePane)!
        if (pending.operation?.acquisition?.reservation.outcome?.kind === 'registration-exited') {
          const adopted = consumeExitedPaneOperation(
            ctx.deps.runtime,
            ctx.deps.store,
            { ...args, ...pane, renderer: adapter.adoption?.().renderer },
            pending.operation
          )
          retirePreparation(adapter, adopted.result.id)
          return finish(adoptedOutcome(adopted))
        }
      }
      ctx.args = { ...ctx.args, ...parsePaneKey(latePane)! }
      return acquire(latePane, complete)
    }
    return complete(operation)
  }
  try {
    if (adapter.replace) {
      await adapter.replace()
    }
    await adapter.admission
    const early = await beginPtySpawn(ctx, adapter.adoption?.().renderer)
    if (early) {
      return finish(adoptedOutcome(early))
    }
    if (adapter.adoption?.().completed?.materialized) {
      return acquire(resolveEarlyPaneKey(args)!, fresh)
    }
    const paneKey = resolveEarlyPaneKey(args)
    return await (paneKey && !ctx.paneSpawnOperation
      ? acquire(paneKey, fresh)
      : fresh(ctx.paneSpawnOperation ?? { mustExist: false }))
  } catch (caught) {
    const error = adapter.onError?.(caught) ?? caught
    adapter.releasePreparation?.()
    adapter.releaseHiddenMark?.()
    cancelRegistration(ctx)
    restoreProvisionalPtySize(ctx)
    if (ctx.replacedPaneOwner) {
      await releaseStoppedPaneBinding(ctx.deps.store, ctx.replacedPaneOwner)
    }
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, error)
    throw error
  } finally {
    cancelRegistration(ctx)
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
