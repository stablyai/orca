import { cancelRegistration } from './spawn-failure-settlement'
import { takeRetainedTerminalAttempt } from '../../runtime/terminal/launch/retained-terminal-operation'
import {
  settlePreparedSpawnFailure,
  settlePreparedSpawnOutcome
} from './spawn-operation-settlement'
import { retirePreparation } from './spawn-operation-preparation'
import { acquirePtySpawnPolicyLease } from './spawn-policy-lease'
import type { PaneSpawnOperation } from './pane/pane-spawn-operation'
import { adoptedOutcome, type PtySpawnOutcome } from './spawn-outcome'
import type { PtySpawnOperationState, SpawnAdapter } from './spawn-operation-state'
import { beginPtySpawn, reportPtyPaneAdoption } from './spawn-begin'
import { executePtySpawn } from './spawn-execute'
import { prepareSavedPtyResume } from './spawn-resume'
import { resolveEarlyPaneKey, resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { consumeExitedPaneOperation } from './pane/adopt-stable'
import { attachOnlyViewOf } from './pane/attach-only-view'
import {
  pendingRuntimePaneCreatesByOwnerKey,
  rejectPaneSpawnReservation,
  reserveIdlePaneSpawn
} from './pane/spawn-reservation'
import { restoreProvisionalPtySize } from './spawn-options-assembly'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { releaseStoppedPaneBinding } from './pane/pane-owner-replacement'
import { BareWorkspaceTerminalLaunchError } from '../../workspaces/catalog/workspace-git-storage'
import {
  admitColdRestoreReattach,
  captureSavedResumeCleanup,
  forgetRefusedResume,
  resumeSpawnRefusal,
  savedResumeRecord,
  savedResumeResult
} from './host-env/saved-resume-admission'

export { normalizePtySpawnSessionId } from './spawn-operation-preparation'

/** One host operation owns preparation, dispatch, settlement and cleanup for every start entry. */
export async function runPtySpawn<State extends PtySpawnOperationState>(
  adapter: SpawnAdapter<State>
): Promise<PtySpawnOutcome> {
  const ctx = adapter.state
  const args = ctx.args
  ctx.preAdoptedStablePane = args.adoptedStablePane ?? null
  ctx.paneSpawnOperation = args.paneSpawnOperation
  const retainedAttempt = {
    current:
      (args.paneSpawnOperation && takeRetainedTerminalAttempt(args.paneSpawnOperation)) ??
      (args.preparedReplacement && takeRetainedTerminalAttempt(args.preparedReplacement)) ??
      null
  }
  const replacementKey = adapter.replace ? resolveEarlyPaneSpawnReservationKey(args) : null
  let prepared = false
  let preparedSettled = false
  const finish = (outcome: PtySpawnOutcome) => {
    if (preparedSettled) {
      return outcome
    }
    preparedSettled = true
    return settlePreparedSpawnOutcome(ctx, outcome, retainedAttempt.current, adapter)
  }
  const inherit = (adopted: Parameters<typeof adoptedOutcome>[0]) => {
    const outcome = adoptedOutcome(adopted)
    Object.assign(outcome.result, ctx.deps.runtime?.getTerminalLaunchResult?.(outcome.result.id))
    return finish(outcome)
  }
  let replacementPrepared = false
  const beginRetainedAttempt = (
    owner:
      | Pick<NonNullable<PaneSpawnOperation['acquisition']>, 'key' | 'reservation'>
      | undefined = ctx.paneSpawnOperation?.acquisition
  ): void => {
    if (!retainedAttempt.current && args.worktreeId && args.tabId && args.leafId) {
      retainedAttempt.current =
        ctx.deps.runtime?.beginRetainedTerminalAttempt(
          args.worktreeId,
          args.tabId,
          args.leafId,
          owner
        ) ?? null
    }
    ctx.preservesEndedPane = Boolean(ctx.args.admitPreparedSpawn || retainedAttempt.current)
  }
  let preparedFailure: ReturnType<typeof settlePreparedSpawnFailure> | undefined
  const settleFailure = (failure: unknown) => {
    if (!preparedFailure) {
      const settled = settlePreparedSpawnFailure(
        ctx,
        failure,
        retainedAttempt.current,
        preparedSettled
      )
      preparedSettled = true
      if (settled.kind === 'superseded') {
        retainedAttempt.current?.accepted()
      }
      preparedFailure = settled
    }
    return preparedFailure
  }
  const complete = async (operation: PaneSpawnOperation): Promise<PtySpawnOutcome> => {
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
    beginRetainedAttempt()
    const runtime = ctx.deps.runtime
    if (!ctx.releaseWorktreeSpawn) {
      await acquirePtySpawnPolicyLease(ctx, args, false)
    }
    await ctx.args.admitPreparedSpawn?.()
    const facts = adapter.facts()
    const chooseFresh = await prepareSavedPtyResume(ctx, facts)
    await executePtySpawn(ctx, facts, chooseFresh)
    if (!ctx.resumeAdmission) {
      ctx.resumeAdmission = await admitColdRestoreReattach(
        runtime,
        ctx.result,
        {
          paneKey: facts.savedResumePaneKey ?? null,
          saved: savedResumeRecord(ctx.deps.store, facts.savedResumePaneKey ?? null)
        },
        ctx.expectedWslDistro
      )
      await captureSavedResumeCleanup(
        runtime,
        ctx.deps.store,
        facts.savedResumePaneKey ?? null,
        ctx.resumeAdmission,
        args.worktreeId
      )
    }
    if (!ctx.result.isReattach) {
      Object.assign(ctx.result, savedResumeResult(ctx.resumeAdmission))
    }
    const outcome = await adapter.commit()
    if (
      outcome.kind === 'committed' ||
      (outcome.kind === 'registration-exited' && adapter.drainsExitedStart)
    ) {
      const refusal = resumeSpawnRefusal(ctx.resumeAdmission)
      forgetRefusedResume(facts.savedResumePaneKey ?? null, refusal)
      if (
        args.worktreeId &&
        facts.savedResumePaneKey &&
        refusal &&
        refusal.verdict !== 'unverifiable'
      ) {
        void runtime
          ?.forgetRefusedSavedResume?.(
            args.worktreeId,
            facts.savedResumePaneKey,
            refusal.refused,
            refusal.sourceRecord
          )
          .catch((error: unknown) => console.warn('[pty] refused resume cleanup failed', error))
      }
      if (!ctx.result.isReattach) {
        runtime?.rememberSavedTerminalLaunchResult?.(outcome.result.id, outcome.result)
      }
    }
    finish(outcome)
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
        try {
          outcome = await fresh(operation)
          return outcome.result
        } catch (caught) {
          if (operation.acquisition?.reservation.outcome || ctx.settledSpawnOutcome) {
            throw caught
          }
          // Adoption releases the reservation when this callback rejects.
          throw settleFailure(adapter.onError?.(caught) ?? caught).error
        }
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
    return inherit(adopted)
  }
  const fresh = async (operation: PaneSpawnOperation): Promise<PtySpawnOutcome> => {
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
    beginRetainedAttempt()
    if (!replacementPrepared) {
      if (prepared) {
        retirePreparation(adapter)
      }
      prepared = true
      await adapter.prepare()
    }
    replacementPrepared = false
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
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
          return inherit(adopted)
        }
      }
      ctx.args = { ...ctx.args, ...parsePaneKey(latePane)! }
      return acquire(latePane, complete)
    }
    return complete(operation)
  }
  try {
    // Keep replacement authority across stopping the previous process.
    if (replacementKey) {
      ctx.paneSpawnReservation = await reserveIdlePaneSpawn(replacementKey)
      ctx.paneSpawnReservationKey = replacementKey
    }
    if (adapter.replace) {
      adapter.captureReplacement?.()
      if (replacementKey && ctx.paneSpawnReservation) {
        beginRetainedAttempt({ key: replacementKey, reservation: ctx.paneSpawnReservation })
      }
      prepared = true
      await adapter.prepare()
      await acquirePtySpawnPolicyLease(ctx, args, true)
      replacementPrepared = true
      await adapter.replace()
    }
    await adapter.admission
    const early = await beginPtySpawn(ctx, adapter.adoption?.().renderer)
    if (early) {
      return inherit(early)
    }
    if (adapter.adoption?.().completed?.materialized) {
      return await acquire(resolveEarlyPaneKey(args)!, fresh)
    }
    const paneKey = resolveEarlyPaneKey(args)
    return await (paneKey && !ctx.paneSpawnOperation
      ? acquire(paneKey, fresh)
      : fresh(ctx.paneSpawnOperation ?? { mustExist: false }))
  } catch (caught) {
    const failure = preparedFailure?.error ?? adapter.onError?.(caught) ?? caught
    const acquisition = ctx.paneSpawnOperation?.acquisition
    const actualOutcome = acquisition?.reservation.outcome ?? ctx.settledSpawnOutcome
    if (actualOutcome) {
      console.warn('[pty] accepted spawn presentation failed:', failure)
      return finish(actualOutcome)
    }
    const { error } = settleFailure(failure)
    adapter.releasePreparation?.()
    adapter.releaseHiddenMark?.()
    cancelRegistration(ctx)
    restoreProvisionalPtySize(ctx)
    if (ctx.replacedPaneOwner && !(caught instanceof BareWorkspaceTerminalLaunchError)) {
      await releaseStoppedPaneBinding(ctx.deps.store, ctx.replacedPaneOwner)
    }
    // Every failure settles the exact reservation so later starts can acquire it.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, error)
    throw error
  } finally {
    retainedAttempt.current?.finalized()
    cancelRegistration(ctx)
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
