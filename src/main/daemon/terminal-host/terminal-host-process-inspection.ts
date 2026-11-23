import type { TerminalForegroundObservation } from '../../../shared/terminal/pty/lifecycle/terminal-foreground-observation'
import { isShellProcess } from '../../../shared/agent-status/process/shell-process-detection'
import { recognizeAgentProcess } from '../../../shared/agent-status/process/agent-process-recognition'
import type { PtyChildProcessVerdict } from '../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import type { RemoteForegroundEvidence } from '../../../shared/terminal/pty/foreground/foreground-process-evidence'
import { getCheapProcessTableSnapshot } from '../../../shared/process-observation/tables/cheap-process-table-snapshot-reader'
import { getStrictProcessTableSnapshotWithAge } from '../../../shared/process-observation/tables/process-table-snapshot-reader'
import { resolveRemoteForegroundEvidence } from '../../providers/foreground/agent-process-batch'
import { buildPaneProcessFingerprint } from '../../providers/foreground/posix-pane-fingerprint'
import type { Session } from '../sessions/session'
import { resolveSpawnFileForegroundFromRows } from '../pty-subprocess/spawn-file-foreground-process'
import { inspectSpawnFileChildProcessesFromRows } from '../pty-subprocess/spawn-file-child-processes'
import {
  clearSteadyStateAnchor,
  getSteadyStateAnchor,
  rememberSteadyStateAnchor
} from './terminal-host-steady-state-anchor'
import { SessionNotFoundError } from '../protocol/daemon-errors'
import {
  paneActivity,
  readProvenIdleShell,
  rememberIdleShellProof
} from './terminal-host-idle-shell-proof'
import { steadyPollJudgesByJobMembership } from '../../providers/pty/process-inspection'

const WINDOWS_FOREGROUND_REFRESH_SETTLE_MS = 1_000
/** Longer than a cached census can lag: its 500 ms reuse window plus a slow scan. */
const WINDOWS_IDLE_PROOF_QUIET_MS = 5_000

export type TerminalHostProcessInspection = {
  foregroundObservation?: TerminalForegroundObservation
  foregroundProcess: string | null
  hasChildProcesses: boolean
  childProcessEvidence?: PtyChildProcessVerdict
  foregroundProcessEvidence?: RemoteForegroundEvidence
  foregroundExitWatched?: true
  /** This read proved the shell alone in front with nothing running; only then may the pane stop re-checking. */
  idleShellProven?: true
}

export type RetiredIncarnation = { incarnationId: string; code: number; expiresAt: number }

/** Cheap POSIX polls reuse anchored identity; unresolved reads escalate to full evidence capture. */
export type TerminalHostInspectionTier = 'full' | 'cheap'

export async function inspectTerminalHostProcess(args: {
  sessionId: string
  session: Session | null
  currentSession?: () => Session | undefined
  expectedIncarnationId?: string
  foregroundOnly?: boolean
  /** The caller is a self-correcting poll that only reads the process name, never evidence. */
  steadyState?: boolean
  /** A steady poll from a pane tracking no agent; a proven idle macOS shell answers from its group. */
  jobMembershipOnly?: boolean
  ignoreDetached?: boolean
  retiredIncarnation?: RetiredIncarnation
  authorityGeneration: string
  nextObservationEpoch: () => number
  onTier?: (tier: TerminalHostInspectionTier) => void
}): Promise<TerminalHostProcessInspection> {
  const { sessionId, session, expectedIncarnationId, retiredIncarnation } = args
  if (!session || !session.isAlive) {
    if (
      retiredIncarnation &&
      retiredIncarnation.expiresAt > Date.now() &&
      expectedIncarnationId === retiredIncarnation.incarnationId
    ) {
      return {
        foregroundProcess: null,
        hasChildProcesses: args.foregroundOnly === true,
        ...(args.foregroundOnly === true ? { childProcessEvidence: 'unverifiable' as const } : {}),
        foregroundProcessEvidence: {
          authorityGeneration: args.authorityGeneration,
          observationEpoch: args.nextObservationEpoch(),
          capturedAgeMs: 0,
          ptyId: sessionId,
          ptyIncarnationId: retiredIncarnation.incarnationId,
          verdict: 'exited',
          reason: `pty_exit_${retiredIncarnation.code}`
        }
      }
    }
    throw new SessionNotFoundError(sessionId)
  }

  const incarnationMatches =
    !expectedIncarnationId || expectedIncarnationId === session.incarnationId
  if (args.foregroundOnly === true) {
    const requestedAt = Date.now()
    const sample = incarnationMatches
      ? await session.observeForeground()
      : { verdict: 'unverifiable' as const, reason: 'incarnation_mismatch' }
    const current = session.isAlive && (!args.currentSession || args.currentSession() === session)
    return {
      foregroundProcess: current && sample.verdict === 'observed' ? sample.processName : null,
      hasChildProcesses: true,
      childProcessEvidence: 'unverifiable',
      foregroundObservation: {
        ptyId: sessionId,
        ptyIncarnationId: session.incarnationId,
        authorityGeneration: args.authorityGeneration,
        observationEpoch: args.nextObservationEpoch(),
        capturedAgeMs: Math.max(0, Date.now() - requestedAt),
        ...(current ? sample : { verdict: 'unverifiable' as const, reason: 'session_changed' })
      }
    }
  }
  // Idle shell panes poll forever; a recent full capture plus the PTY's foreground group answers them in O(1).
  if (
    args.steadyState === true &&
    args.jobMembershipOnly === true &&
    incarnationMatches &&
    process.platform === 'darwin' &&
    !session.processNameIsSpawnFile
  ) {
    const shell = await readProvenIdleShell(
      session,
      () => !args.currentSession || args.currentSession() === session
    )
    if (shell !== null) {
      args.onTier?.('cheap')
      return {
        foregroundProcess: shell.name,
        hasChildProcesses: false,
        ...(shell.idle ? { idleShellProven: true as const } : {})
      }
    }
  }
  if (args.steadyState === true && incarnationMatches) {
    const anchored = await readAnchoredForeground(session)
    if (anchored !== null) {
      args.onTier?.('cheap')
      // A tty-less capture cannot supply fencing evidence to remote or restore consumers.
      return { foregroundProcess: anchored, hasChildProcesses: true }
    }
  }
  args.onTier?.('full')

  const windowsDecision = process.platform === 'win32' && args.steadyState !== true
  let foregroundProcess = windowsDecision ? null : session.getForegroundProcess()
  let childProcessEvidence: PtyChildProcessVerdict | undefined = session.processNameIsSpawnFile
    ? 'unverifiable'
    : undefined
  let evidence: RemoteForegroundEvidence
  let idleShellProven = false
  if (!incarnationMatches) {
    evidence = unverifiableEvidence(args, session, 'incarnation_mismatch')
  } else if (process.platform === 'win32') {
    const activity = paneActivity(session)
    const readStartedAt = Date.now()
    if (windowsDecision || session.processNameIsSpawnFile) {
      foregroundProcess = await session.confirmForegroundProcess(
        windowsDecision ? { decision: true } : undefined
      )
    } else {
      // The name lookup runs after the shell name is returned; an event read must carry its result,
      // because nothing re-reads once it lands.
      await session.settleForegroundRefresh(WINDOWS_FOREGROUND_REFRESH_SETTLE_MS)
      foregroundProcess = session.getForegroundProcess()
    }
    // A steady-state poll never decides adoption or close, so it may read the cached process table.
    childProcessEvidence = await session.inspectChildProcesses(
      args.steadyState !== true,
      args.ignoreDetached === true,
      steadyPollJudgesByJobMembership(args, foregroundProcess)
    )
    // A full census (escaped children included) is the only Windows proof; wsl.exe cannot prove its guest idle.
    // A cached census may predate recent input or output, so prove only a pane quiet since before it could start.
    idleShellProven =
      childProcessEvidence === 'no-children' &&
      foregroundProcess !== null &&
      isShellProcess(foregroundProcess) &&
      paneActivity(session) === activity &&
      readStartedAt - session.lastActivityAt > WINDOWS_IDLE_PROOF_QUIET_MS
    // Windows cannot provide this POSIX evidence; avoid spawning an MSYS ps.exe console.
    evidence = unverifiableEvidence(args, session, 'windows_ssh_foreground_unavailable')
  } else {
    try {
      const activity = paneActivity(session)
      const snapshot = await getStrictProcessTableSnapshotWithAge()
      // A shared capture that started before the pane's latest input or output may predate a child it started.
      const capturedAfterActivity = Date.now() - snapshot.capturedAgeMs > session.lastActivityAt
      idleShellProven =
        !session.processNameIsSpawnFile &&
        rememberIdleShellProof(
          session,
          snapshot.rows,
          snapshot.capturedAgeMs,
          activity,
          capturedAfterActivity
        )
      if (session.processNameIsSpawnFile) {
        const observed = resolveSpawnFileForegroundFromRows(snapshot.rows, session.pid)
        foregroundProcess = observed.available ? observed.processName : foregroundProcess
        childProcessEvidence = inspectSpawnFileChildProcessesFromRows(
          snapshot.rows,
          session.pid,
          session.getForegroundProcess({ rawFallback: true })
        )
        if (observed.available && observed.processName && !isShellProcess(observed.processName)) {
          childProcessEvidence = 'children'
        }
      }
      evidence = resolveRemoteForegroundEvidence(
        { rootPid: session.pid, fallbackProcess: foregroundProcess },
        {
          ptyId: sessionId,
          ptyIncarnationId: session.incarnationId,
          authorityGeneration: args.authorityGeneration,
          observationEpoch: args.nextObservationEpoch(),
          capturedAgeMs: snapshot.capturedAgeMs,
          platform: process.platform
        },
        snapshot.rows
      )
      await rememberSteadyStateAnchor(session, evidence, snapshot.rows)
      // Output or input after the capture may be a command the capture predates.
      idleShellProven &&= paneActivity(session) === activity
    } catch {
      idleShellProven = false
      evidence = unverifiableEvidence(args, session, 'process_table_unreadable')
      clearSteadyStateAnchor(session)
    }
  }
  if (!session.isAlive || (args.currentSession && args.currentSession() !== session)) {
    childProcessEvidence = 'unverifiable'
    evidence = unverifiableEvidence(args, session, 'session_changed')
    idleShellProven = false
  }
  const nonShellForeground = foregroundProcess !== null && !isShellProcess(foregroundProcess)
  // Agent-only evidence must not erase an ordinary foreground command.
  const ordinaryForeground =
    nonShellForeground && !recognizeAgentProcess(foregroundProcess) ? foregroundProcess : null
  return {
    foregroundProcess:
      evidence.verdict === 'live'
        ? (evidence.processName ?? ordinaryForeground)
        : foregroundProcess,
    hasChildProcesses:
      childProcessEvidence === undefined
        ? nonShellForeground
        : childProcessEvidence !== 'no-children',
    ...(childProcessEvidence === undefined ? {} : { childProcessEvidence }),
    foregroundProcessEvidence: evidence,
    ...(idleShellProven ? { idleShellProven: true as const } : {})
  }
}

/** Reuse identity only while the pane fingerprint and raw foreground name still match the full capture. */
async function readAnchoredForeground(session: Session): Promise<string | null> {
  const anchor = getSteadyStateAnchor(session)
  if (process.platform === 'win32' || !anchor) {
    return null
  }
  if (session.getForegroundProcess({ rawFallback: true }) !== anchor.rawFallback) {
    return null
  }
  try {
    const observed = await buildPaneProcessFingerprint(
      await getCheapProcessTableSnapshot(),
      session.pid
    )
    return observed !== null && observed === anchor.fingerprint ? anchor.agentName : null
  } catch {
    return null
  }
}

function unverifiableEvidence(
  args: {
    sessionId: string
    authorityGeneration: string
    nextObservationEpoch: () => number
  },
  session: Session,
  reason: string
): RemoteForegroundEvidence {
  return {
    authorityGeneration: args.authorityGeneration,
    observationEpoch: args.nextObservationEpoch(),
    capturedAgeMs: 0,
    ptyId: args.sessionId,
    ptyIncarnationId: session.incarnationId,
    verdict: 'unverifiable',
    reason
  }
}
