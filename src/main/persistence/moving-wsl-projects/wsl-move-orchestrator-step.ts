/**
 * One orchestrator step for a distro: the pending-Remove and R38 checks, the A1 gate, then the
 * preview and, when it is clear, the move. Every wait re-reads the record, so a choice the user
 * made meanwhile (a release, Not now) wins over the step's stale view.
 */
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorTrigger
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import {
  applyWslMovedDistroVerdict,
  applyWslMoveHostRemovalPending,
  applyWslMoveHostRemovalSettled,
  type WslMovedDistroVerdict
} from './wsl-move-orchestrator-external-transitions'
import type {
  WslMoveFinishedMove,
  WslMoveHostReadiness,
  WslMoveOrchestratorPorts
} from './wsl-move-orchestrator-ports'
import {
  applyWslMoveOutcome,
  classifyWslMoveOutcome,
  mayStartWslMove
} from './wsl-move-orchestrator-transitions'

export type WslMoveOrchestratorStepContext = {
  ports: WslMoveOrchestratorPorts
  /** The distro's record when the step began. */
  record: WslMoveOrchestratorRecord
  /** True when the stored record is no longer `seen`. */
  changedUnder: (seen: WslMoveOrchestratorRecord) => boolean
  /** Stores the record and returns the one now stored. */
  commit: (
    next: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult
  ) => WslMoveOrchestratorRecord
}

/** The newest finished move; `unknown` when the journal cannot be read. */
export function readWslMoveFinishedMove(
  ports: Pick<WslMoveOrchestratorPorts, 'finishedMove'>,
  distro: string
): WslMoveFinishedMove | null | 'unknown' {
  try {
    return ports.finishedMove(distro)
  } catch {
    return 'unknown'
  }
}

/** A port that throws is a transient failure, never a lost record. */
async function settle<T extends WslMovePreview | WslMoveResult>(
  run: () => Promise<T>
): Promise<T | { outcome: 'reset'; migrationId: string; detail: string }> {
  try {
    return await run()
  } catch (error) {
    return {
      outcome: 'reset',
      migrationId: '',
      detail: error instanceof Error ? error.message : 'orchestrator_error'
    }
  }
}

export async function runWslMoveOrchestratorStep(
  context: WslMoveOrchestratorStepContext,
  distro: string,
  trigger: WslMoveOrchestratorTrigger
): Promise<void> {
  const { ports, changedUnder, commit } = context
  const now = (): number => ports.now()
  const apply = (
    record: WslMoveOrchestratorRecord,
    cause: WslMovePreview | WslMoveResult
  ): WslMoveOrchestratorRecord =>
    applyWslMoveOutcome(record, classifyWslMoveOutcome(cause), {
      now: now(),
      appVersion: ports.appVersion,
      trigger
    })
  let record = context.record
  // Before anything that could connect, add or move: even the user's Retry waits for the Remove.
  let removalPending: boolean
  try {
    removalPending = ports.hostRemovalPending(distro)
  } catch {
    // An unreadable host record proves nothing either way; touch nothing this time.
    return
  }
  if (removalPending) {
    commit(applyWslMoveHostRemovalPending(record, now()))
    return
  }
  // The Remove settled: a kept host (the user pressed Connect) resumes; a gone one was declined.
  if (record.state.kind === 'parked' && record.state.reason === 'removal-pending') {
    record = commit(applyWslMoveHostRemovalSettled(record, ports.hasHost(distro), now()))
  }
  // A timer re-check leaves R38 to the triggers, so a deferred move never polls the registry.
  const finished = trigger === 'timer' ? null : readWslMoveFinishedMove(ports, distro)
  if (finished === 'unknown') {
    return
  }
  if (finished) {
    const verdict = await ports
      .checkMovedDistro(distro, finished)
      .catch((): WslMovedDistroVerdict => 'unknown')
    if (changedUnder(record)) {
      return
    }
    record = commit(applyWslMovedDistroVerdict(record, verdict, now()))
  }
  if (!mayStartWslMove(record, trigger, now(), ports.appVersion)) {
    return
  }
  // A1: only an explicit user action may wake a distro; every other step needs it running.
  // A timer step never connects either: connecting can hold a running distro up.
  if (trigger === 'timer') {
    if (!ports.isHostReady(distro)) {
      return
    }
  } else if (trigger !== 'user') {
    const seen = record
    const readiness = await ports
      .prepareHost(distro, () => !changedUnder(seen))
      .catch((): WslMoveHostReadiness => 'unverifiable')
    if (readiness !== 'ready' || changedUnder(record)) {
      return
    }
  }
  const preview = await settle(() => ports.preview(distro, trigger === 'user'))
  if (changedUnder(record)) {
    return
  }
  record = commit(apply(record, preview), preview)
  if (record.state.kind !== 'moving') {
    return
  }
  const started = record
  // The port re-checks this once it has the window's panes, just before the driver claims the run.
  const result = await settle(() => ports.start(distro, () => !changedUnder(started)))
  if (!changedUnder(record)) {
    commit(apply(record, result), result)
  }
}
