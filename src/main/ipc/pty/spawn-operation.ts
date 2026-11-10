import { completePtySpawn } from './spawn-operation-completion'
import {
  rebaseLegacyPtyRequest,
  legacyPaneIdentitySelection,
  applyLegacyPaneAcquisition
} from './pane/legacy-pane-identity-selection'
import {
  admitLegacyTerminalRestore,
  locateLegacyTerminalRestore
} from '../../pty/legacy-terminal-restore-ownership'
import { retireClosedPtySpawn } from './pane/spawn-registration'
import type { PaneSpawnOperation } from './pane/pane-spawn-operation'
import { normalizeFreshPtySessionId } from '../../daemon/sessions/pty-session-id'
import type { AdoptStablePaneArgs } from './ipc/spawn-types'
import { adoptedOutcome, type PtySpawnOutcome } from './spawn-outcome'
import type { PtySpawnOperationState, PtySpawnExecutionFacts } from './spawn-operation-state'
import { beginPtySpawn, reportPtyPaneAdoption } from './spawn-begin'
import { resolveEarlyPaneKey, resolveEarlyPaneSpawnReservationKey } from './spawn-pane-coordinates'
import { carryLegacyPaneAcquisition, consumeExitedPaneOperation } from './pane/adopt-stable'
import { attachOnlyViewOf } from './pane/attach-only-view'
import {
  pendingRuntimePaneCreatesByOwnerKey,
  rejectPaneSpawnReservation,
  reserveIdlePaneSpawn
} from './pane/spawn-reservation'
import { restoreProvisionalPtySize } from './spawn-options-assembly'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { releaseStoppedPaneBinding } from './pane/pane-owner-replacement'

export type SpawnAdapter<State extends PtySpawnOperationState> = {
  state: State
  prepare: () => Promise<void>
  commit: () => Promise<PtySpawnOutcome>
  facts: () => PtySpawnExecutionFacts
  admission?: Promise<void>
  drainsExitedStart?: true
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
  ctx.args = normalizeFreshPtySessionId(ctx.args)
  rebaseLegacyPtyRequest(ctx)
  const args = ctx.args
  const identityAuthority = !args.connectionId
    ? ctx.deps.store?.legacyTerminalIdentityAuthority
    : undefined
  const savedSession = identityAuthority ? ctx.deps.store?.getWorkspaceSession() : undefined
  const savedId =
    args.tabId && args.leafId
      ? savedSession?.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId]
      : undefined
  const legacyRequest =
    /^\d+$/.test(args.sessionId ?? savedId ?? '') ||
    (args.tabId &&
      savedSession?.tabsByWorktree?.[args.worktreeId ?? '']?.some(
        (row) => row.id === args.tabId && /^\d+$/.test(row.ptyId ?? '')
      ))
  const restoreAdmission =
    !args.paneSpawnOperation?.legacyRestore &&
    identityAuthority &&
    legacyRequest &&
    args.worktreeId &&
    !args.isNewSession &&
    !adapter.replace
      ? admitLegacyTerminalRestore(
          identityAuthority,
          args.worktreeId,
          args.tabId,
          args.leafId,
          ctx.deps.runtime?.markPtyLivenessUnverifiable?.bind(ctx.deps.runtime)
        )
      : undefined
  if (restoreAdmission) {
    args.signal = args.signal
      ? AbortSignal.any([args.signal, restoreAdmission.attempt.close.signal])
      : restoreAdmission.attempt.close.signal
  }
  ctx.preAdoptedStablePane = args.adoptedStablePane ?? null
  ctx.paneSpawnOperation = args.paneSpawnOperation
  const replacementKey = adapter.replace ? resolveEarlyPaneSpawnReservationKey(args) : null
  // Keep replacement authority across stopping the previous process.
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
  const inherit = (adopted: Parameters<typeof adoptedOutcome>[0]) => {
    const outcome = adoptedOutcome(adopted)
    Object.assign(outcome.result, ctx.deps.runtime?.getTerminalLaunchResult?.(outcome.result.id))
    return finish(outcome)
  }
  const complete = (operation: PaneSpawnOperation) =>
    completePtySpawn(
      adapter,
      operation,
      operation.legacyRestore?.attempt ?? restoreAdmission?.attempt,
      finish
    )
  const acquire = async (
    paneKey: string,
    fresh: (operation: PaneSpawnOperation) => Promise<PtySpawnOutcome>
  ) => {
    const pane = parsePaneKey(paneKey)!
    if (restoreAdmission && identityAuthority) {
      locateLegacyTerminalRestore(
        identityAuthority,
        restoreAdmission.attempt,
        pane.tabId,
        pane.leafId
      )
    }
    let outcome: PtySpawnOutcome | undefined
    const selection = legacyPaneIdentitySelection(ctx, paneKey, restoreAdmission?.attempt)
    const legacyRestore = restoreAdmission
      ? { attempt: restoreAdmission.attempt, selection }
      : undefined
    const adopted = await ctx.deps.adoptStablePane(
      carryLegacyPaneAcquisition(
        {
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
            const identityChanged = applyLegacyPaneAcquisition(operation, ctx.args)
            const paneChanged =
              operation.legacyRestore && adapter.facts().paneKey !== resolveEarlyPaneKey(ctx.args)
            if (prepared && (identityChanged || paneChanged)) {
              retirePreparation(adapter)
              prepared = true
              await adapter.prepare()
            }
            outcome = await fresh(operation)
            return outcome.result
          }
        },
        legacyRestore ?? false
      )
    )
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
    if (prepared) {
      retirePreparation(adapter)
    }
    ctx.paneSpawnOperation = operation
    ctx.args.paneSpawnOperation = operation
    applyLegacyPaneAcquisition(operation, ctx.args)
    if (operation.legacyRestore?.attempt.closed) {
      throw new Error('terminal_pane_owner_changed')
    }
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
          return inherit(adopted)
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
    const attempt = ctx.paneSpawnOperation?.legacyRestore?.attempt ?? restoreAdmission?.attempt
    if (attempt?.closed) {
      const result = ctx.rejectedRegistrationCandidate ?? ctx.result
      if (result && result.id === (attempt.selectedId ?? ctx.args.sessionId)) {
        await retireClosedPtySpawn(ctx.provider, result, ctx.deps.runtime, attempt.selectedId)
      }
    }
    const error = adapter.onError?.(caught) ?? caught
    adapter.releasePreparation?.()
    adapter.releaseHiddenMark?.()
    cancelRegistration(ctx)
    restoreProvisionalPtySize(ctx)
    if (ctx.replacedPaneOwner) {
      await releaseStoppedPaneBinding(ctx.deps.store, ctx.replacedPaneOwner)
    }
    // Every failure settles the exact reservation so later starts can acquire it.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, error)
    throw error
  } finally {
    cancelRegistration(ctx)
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
    restoreAdmission?.release()
  }
}
