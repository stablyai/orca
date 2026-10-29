import { pruneRetiredPtyIncarnations } from '../../shared/retired-pty-incarnations'
import { getInspectableTerminalHostSession } from './terminal-host-session-access'
import { isShellProcess } from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type {
  ClaudePeerIdentity,
  PtyChildProcessVerdict
} from '../../shared/terminal-process-inspection'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { getCheapProcessTableSnapshot } from '../../shared/cheap-process-table-snapshot-reader'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import { buildPaneProcessFingerprint } from '../providers/posix-pane-foreground-fingerprint'
import type { Session } from './session'
import { resolveSpawnFileForegroundFromRows } from './pty-subprocess/spawn-file-foreground-process'
import { inspectSpawnFileChildProcessesFromRows } from './pty-subprocess/spawn-file-child-processes'
import {
  clearSteadyStateAnchor,
  getSteadyStateAnchor,
  rememberSteadyStateAnchor
} from './terminal-host-steady-state-anchor'
import { SessionNotFoundError } from './types'
import type { PtyProcessInspectionOptions } from '../providers/pty-process-inspection'

export type TerminalHostProcessInspection = ClaudePeerIdentity & {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  childProcessEvidence?: PtyChildProcessVerdict
  foregroundProcessEvidence?: RemoteForegroundEvidence
}

type RetiredIncarnation = { incarnationId: string; code: number; expiresAt: number }

/** Cheap POSIX polls reuse anchored identity; unresolved reads escalate to full evidence capture. */
export type TerminalHostInspectionTier = 'full' | 'cheap'

/** Inspects a hosted session's foreground and children, attaching Claude peer data only if the session is unchanged. */
export async function inspectTerminalHostProcess(args: {
  sessionId: string
  session: Session | null
  currentSession?: () => Session | undefined
  expectedIncarnationId?: string
  /** The caller is a self-correcting poll that only reads the process name, never evidence. */
  steadyState?: boolean
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
        hasChildProcesses: false,
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
  if (args.steadyState === true && incarnationMatches) {
    const anchored = await readAnchoredForeground(session)
    if (anchored !== null) {
      args.onTier?.('cheap')
      // A tty-less capture cannot supply fencing evidence to remote or restore consumers.
      const identity = await session.readClaudePeerIdentity(
        anchored,
        getSteadyStateAnchor(session)?.processId
      )
      if (!session.isAlive || (args.currentSession && args.currentSession() !== session)) {
        return {
          foregroundProcess: null,
          hasChildProcesses: true,
          childProcessEvidence: 'unverifiable'
        }
      }
      return { foregroundProcess: anchored, hasChildProcesses: true, ...identity }
    }
  }
  args.onTier?.('full')

  const windowsDecision = process.platform === 'win32' && args.steadyState !== true
  let foregroundProcess = windowsDecision ? null : session.getForegroundProcess()
  let childProcessEvidence: PtyChildProcessVerdict | undefined = session.processNameIsSpawnFile
    ? 'unverifiable'
    : undefined
  let evidence: RemoteForegroundEvidence
  if (!incarnationMatches) {
    evidence = unverifiableEvidence(args, session, 'incarnation_mismatch')
  } else if (process.platform === 'win32') {
    if (windowsDecision || session.processNameIsSpawnFile) {
      foregroundProcess = await session.confirmForegroundProcess(
        windowsDecision ? { decision: true } : undefined
      )
    }
    // A steady-state poll never decides adoption or close, so it may read the cached process table.
    childProcessEvidence = await session.inspectChildProcesses(
      args.steadyState !== true,
      args.ignoreDetached === true
    )
    // Windows cannot provide this POSIX evidence; avoid spawning an MSYS ps.exe console.
    evidence = unverifiableEvidence(args, session, 'windows_ssh_foreground_unavailable')
  } else {
    try {
      const snapshot = await getStrictProcessTableSnapshotWithAge()
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
    } catch {
      evidence = unverifiableEvidence(args, session, 'process_table_unreadable')
      clearSteadyStateAnchor(session)
    }
  }
  if (!session.isAlive || (args.currentSession && args.currentSession() !== session)) {
    childProcessEvidence = 'unverifiable'
    evidence = unverifiableEvidence(args, session, 'session_changed')
  }
  const peerIdentity =
    incarnationMatches && session.isAlive
      ? await session.readClaudePeerIdentity(
          evidence.verdict === 'live' ? evidence.processName : foregroundProcess,
          evidence.verdict === 'live' ? evidence.fence.process?.pid : undefined
        )
      : undefined
  const sessionUnchanged =
    session.isAlive && (!args.currentSession || args.currentSession() === session)
  if (!sessionUnchanged) {
    childProcessEvidence = 'unverifiable'
    evidence = unverifiableEvidence(args, session, 'session_changed')
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
    ...(sessionUnchanged ? peerIdentity : {})
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

export function inspectTerminalHostSession(
  sessions: ReadonlyMap<string, Session>,
  retired: Map<string, RetiredIncarnation>,
  sessionId: string,
  options: PtyProcessInspectionOptions | undefined,
  authorityGeneration: string,
  nextObservationEpoch: () => number
): Promise<TerminalHostProcessInspection> {
  pruneRetiredPtyIncarnations(retired)
  const session = getInspectableTerminalHostSession(
    sessions,
    retired,
    sessionId,
    options?.expectedIncarnationId
  )
  return inspectTerminalHostProcess({
    sessionId,
    currentSession: () => sessions.get(sessionId),
    session: session?.isAlive ? session : null,
    ...options,
    retiredIncarnation: retired.get(sessionId),
    authorityGeneration,
    nextObservationEpoch
  })
}
