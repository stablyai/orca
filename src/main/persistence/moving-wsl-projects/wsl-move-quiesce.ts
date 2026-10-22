/**
 * Pausing a moving project's terminals (mover design, section 3.3): the gate must pass, the fence
 * goes up, Sleep pauses every workspace in scope, and the daemon must prove each session exited
 * before the journal says `quiesced`. Nothing is ever ended to make progress.
 *
 * A refusal after the fence lifts it again. Workspaces Sleep already paused stay asleep: that is
 * their ordinary sleeping state, and waking them later restores them from it, so nothing is lost.
 */
import type { WslMoveCutover } from '../../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveExitProof, WslMoveExitProofScope } from './wsl-move-exit-proof'
import type { WslMoveRestoreHintCapture, WslMoveRestoreHintPane } from './wsl-move-restore-hints'
import {
  assessWslMoveTerminals,
  type WslMoveGateBlocker,
  type WslMoveGateInputs
} from './wsl-move-terminal-gate'

export type WslMoveQuiesceScope = {
  /** Every worktree and folder workspace of the moving projects; each one is slept. */
  workspaceIds: readonly string[]
  /** Workspace keys as session ids mint them, for the exit proof. */
  workspaceKeys: ReadonlySet<string>
  /** The panes the move carries, with each one's daemon session and its distro read before Sleep. */
  panes: readonly WslMoveRestoreHintPane[]
}

export type WslMoveQuiesceDeps = {
  gateInputs: () => Promise<WslMoveGateInputs>
  /** Resolves with the workspaces whose Sleep failed; rejects when the renderer cannot answer. */
  sleepWorkspaces: (workspaceIds: readonly string[]) => Promise<{ failedWorktreeIds: string[] }>
  /** PTYs this process still holds for the workspaces, daemon-backed or not. */
  livePtyIds: (workspaceIds: readonly string[]) => readonly string[]
  captureRestoreHints: (
    panes: WslMoveQuiesceScope['panes'],
    distro: string
  ) => Promise<WslMoveRestoreHintCapture>
  proveExited: (scope: WslMoveExitProofScope) => Promise<WslMoveExitProof>
  writeCutover: (cutover: WslMoveCutover) => void
  removeCutover: (migrationId: string) => void
  now: () => Date
}

export type WslMoveQuiesceRefusalReason =
  | 'terminals-blocked'
  /** Another quiesce for the same distro is still running in this process. */
  | 'quiesce-in-progress'
  | 'fence-failed'
  | 'renderer-unavailable'
  | 'sleep-timed-out'
  | 'sleep-failed'
  | 'terminals-live'
  | 'exit-unverifiable'
  | 'journal-failed'
  /** Anything else that threw after the fence went up. */
  | 'quiesce-failed'

export type WslMoveQuiesceResult =
  | {
      outcome: 'quiesced'
      cutover: WslMoveCutover
      // Not in the journal: the schema has no field for them yet, so the caller carries them on.
      restoreHints: WslMoveRestoreHintCapture
    }
  | {
      outcome: 'refused'
      reason: WslMoveQuiesceRefusalReason
      blockers?: WslMoveGateBlocker[]
      failedWorktreeIds?: string[]
      liveSessionIds?: string[]
      detail?: string
      /** False only when the journal record could not be removed, so the fence still stands. */
      fenceLifted: boolean
    }

type Refusal = Extract<WslMoveQuiesceResult, { outcome: 'refused' }>

// Journal keys with a quiesce running in this process; the journal alone cannot order two of them.
const quiescingJournalKeys = new Set<string>()

export async function quiesceWslMove(
  prepared: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps
): Promise<WslMoveQuiesceResult> {
  if (prepared.phase !== 'prepared') {
    throw new Error('wsl_move_not_prepared')
  }
  if (quiescingJournalKeys.has(prepared.journalKey)) {
    return { outcome: 'refused', reason: 'quiesce-in-progress', fenceLifted: true }
  }
  quiescingJournalKeys.add(prepared.journalKey)
  try {
    return await quiesceUnderLock(prepared, scope, deps)
  } finally {
    quiescingJournalKeys.delete(prepared.journalKey)
  }
}

async function quiesceUnderLock(
  prepared: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps
): Promise<WslMoveQuiesceResult> {
  const gate = assessWslMoveTerminals(await deps.gateInputs())
  if (gate.verdict === 'blocked') {
    return {
      outcome: 'refused',
      reason: 'terminals-blocked',
      blockers: gate.blockers,
      fenceLifted: true
    }
  }
  const fenced: WslMoveCutover = {
    ...prepared,
    phase: 'source-fenced',
    updatedAt: deps.now().toISOString()
  }
  try {
    deps.writeCutover(fenced)
  } catch (error) {
    return {
      outcome: 'refused',
      reason: 'fence-failed',
      detail: describe(error),
      fenceLifted: true
    }
  }
  const refuse = (refusal: Omit<Refusal, 'outcome' | 'fenceLifted'>): Refusal => {
    try {
      deps.removeCutover(fenced.migrationId)
      return { outcome: 'refused', ...refusal, fenceLifted: true }
    } catch (error) {
      console.warn('[wsl-move] Could not lift the fence after a refused quiesce:', error)
      return { outcome: 'refused', ...refusal, fenceLifted: false }
    }
  }

  try {
    // The fence blocks new terminals, not commands typed into open shells; a sub-second window remains.
    const fencedGate = assessWslMoveTerminals(await deps.gateInputs())
    if (fencedGate.verdict === 'blocked') {
      return refuse({ reason: 'terminals-blocked', blockers: fencedGate.blockers })
    }
  } catch (error) {
    return refuse({ reason: 'quiesce-failed', detail: describe(error) })
  }

  try {
    const { failedWorktreeIds } = await deps.sleepWorkspaces(scope.workspaceIds)
    if (failedWorktreeIds.length > 0) {
      return refuse({ reason: 'sleep-failed', failedWorktreeIds })
    }
  } catch (error) {
    const detail = describe(error)
    const reason =
      detail === 'renderer_unavailable'
        ? 'renderer-unavailable'
        : detail === 'worktree_sleep_timeout'
          ? 'sleep-timed-out'
          : 'sleep-failed'
    return refuse({ reason, detail })
  }

  try {
    return await proveAndRecord(fenced, scope, deps, refuse)
  } catch (error) {
    return refuse({ reason: 'quiesce-failed', detail: describe(error) })
  }
}

async function proveAndRecord(
  fenced: WslMoveCutover,
  scope: WslMoveQuiesceScope,
  deps: WslMoveQuiesceDeps,
  refuse: (refusal: Omit<Refusal, 'outcome' | 'fenceLifted'>) => Refusal
): Promise<WslMoveQuiesceResult> {
  // Not the gate's pane probe: a slept pane has no process to ask, so it would read unverifiable.
  const live = deps.livePtyIds(scope.workspaceIds)
  if (live.length > 0) {
    return refuse({ reason: 'terminals-live', liveSessionIds: [...live] })
  }
  const distro = fenced.manifest.source.distro
  const restoreHints = await deps.captureRestoreHints(scope.panes, distro)
  const sessionIds = new Set(scope.panes.map((pane) => pane.sessionId))
  // Last, so a session that came back while the hints were read still refuses.
  const proof = await deps.proveExited({ distro, workspaceKeys: scope.workspaceKeys, sessionIds })
  if (proof.verdict === 'live') {
    return refuse({ reason: 'terminals-live', liveSessionIds: proof.sessionIds })
  }
  if (proof.verdict === 'unverifiable') {
    return refuse({ reason: 'exit-unverifiable', detail: proof.reason })
  }
  const quiesced: WslMoveCutover = {
    ...fenced,
    phase: 'quiesced',
    updatedAt: deps.now().toISOString(),
    provenExitedSessionIds: [...sessionIds]
  }
  try {
    deps.writeCutover(quiesced)
  } catch (error) {
    return refuse({ reason: 'journal-failed', detail: describe(error) })
  }
  return { outcome: 'quiesced', cutover: quiesced, restoreHints }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
