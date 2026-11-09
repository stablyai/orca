import type { PaneSpawnOperation } from './pane/pane-spawn-operation'
import type { PtySpawnOutcome } from './spawn-outcome'
import type { PtySpawnOperationState } from './spawn-operation-state'
import type { SpawnAdapter } from './spawn-operation'
import {
  carrySelectedLegacyIdentity,
  assertSelectedLegacyIdentityOpen
} from './pane/legacy-pane-identity-selection'
import type { LegacyTerminalRestoreAttempt } from '../../pty/legacy-terminal-restore-ownership'
import { spawnWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { executePtySpawn } from './spawn-execute'
import { prepareSavedPtyResume } from './spawn-resume'
import {
  admitColdRestoreReattach,
  captureSavedResumeCleanup,
  forgetRefusedResume,
  resumeSpawnRefusal,
  savedResumeRecord,
  savedResumeResult
} from './host-env/saved-resume-admission'

export async function completePtySpawn<State extends PtySpawnOperationState>(
  adapter: SpawnAdapter<State>,
  operation: PaneSpawnOperation,
  attempt: LegacyTerminalRestoreAttempt | undefined,
  finish: (outcome: PtySpawnOutcome) => PtySpawnOutcome
): Promise<PtySpawnOutcome> {
  const ctx = adapter.state
  const args = ctx.args
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
  carrySelectedLegacyIdentity(ctx.args, ctx.spawnOptions)
  assertSelectedLegacyIdentityOpen(ctx.args)
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
  if (attempt?.closed) {
    throw new Error('terminal_pane_owner_changed')
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
