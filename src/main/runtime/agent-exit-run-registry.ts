import type { AgentProcessIdentity } from '../../shared/agent-process-presence'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'

// Why 15 s: a silent exit nothing reported is still found while the user reads.
export const AGENT_PRESENCE_FALLBACK_INTERVAL_MS = 15_000
// Why stop after three: an unreadable host must not become a poll; a change signal (a nudge)
// still buys one look, at most once per fallback interval.
export const AGENT_PRESENCE_BACKOFF_MS = [30_000, 60_000] as const
// Why a few slow looks: a gone process whose end could not be read must not stay chat forever
// over an idle shell, yet an unreadable pane must not become a poll.
export const AGENT_END_FOLLOW_UP_DELAYS_MS = [120_000, 300_000, 600_000] as const

/** The next attempt after `failures` unverifiable ones: backed off, then never until a new run. */
export function nextAgentPresenceAttemptAtMs(failures: number, nowMs = Date.now()): number {
  const backoff = AGENT_PRESENCE_BACKOFF_MS[failures - 1]
  return backoff === undefined ? Number.POSITIVE_INFINITY : nowMs + backoff
}

/**
 * One agent run in one PTY incarnation: the process an exit proof must be about. A new owner, a
 * new recognized process or a relaunch begins a new run before anything asynchronous happens, so
 * evidence about an older run can never act on a newer one.
 */
export type AgentExitRun = {
  readonly runId: number
  readonly ptyId: string
  readonly incarnationId: string | null
  agent: string | null
  identity: AgentProcessIdentity | null
  source: 'hook' | 'foreground'
  /** Its end was consumed (a retirement started, or a replacement superseded it). */
  endHandled: boolean
  /** Its end was proven: it no longer blocks finding the next run in this PTY. */
  exitProven: boolean
  /** The targeted probe found its process gone; a later agent here is unknown even if unproven. */
  processGone: boolean
  /** When its canonical owner reported its own end; a later look may still need to confirm it. */
  ownerEndedAtMs?: number
  failedProbes: number
  nextProbeAtMs: number
  /** Unverifiable end checks so far; each backs off the next like a probe, then stops. */
  failedEndChecks: number
  nextEndCheckAtMs: number
  /** Last end check; a change signal may re-arm one no sooner than the fallback interval after it. */
  lastEndCheckAtMs: number
  /** Timed follow-up end checks spent for a gone process (see AGENT_END_FOLLOW_UP_DELAYS_MS). */
  endFollowUps: number
  /** A change signal arrived while an end check was in flight: re-check once after it settles. */
  endRecheckPending: boolean
}

export class AgentExitRunRegistry {
  private nextRunId = 1
  private readonly runs = new Map<string, AgentExitRun>()

  current(ptyId: string): AgentExitRun | undefined {
    return this.runs.get(ptyId)
  }

  isCurrent(run: AgentExitRun): boolean {
    return this.runs.get(run.ptyId) === run
  }

  begin(
    ptyId: string,
    init: Pick<AgentExitRun, 'incarnationId' | 'agent' | 'identity' | 'source'>,
    nowMs = Date.now()
  ): AgentExitRun {
    const run: AgentExitRun = {
      runId: this.nextRunId++,
      ptyId,
      ...init,
      endHandled: false,
      exitProven: false,
      processGone: false,
      failedProbes: 0,
      nextProbeAtMs: nowMs + AGENT_PRESENCE_FALLBACK_INTERVAL_MS,
      failedEndChecks: 0,
      nextEndCheckAtMs: 0,
      lastEndCheckAtMs: Number.NEGATIVE_INFINITY,
      endFollowUps: 0,
      endRecheckPending: false
    }
    this.runs.set(ptyId, run)
    return run
  }

  forget(ptyId: string): void {
    this.runs.delete(ptyId)
  }

  all(): AgentExitRun[] {
    return [...this.runs.values()]
  }
}

/**
 * The recognized agent a fenced, incarnation-matched foreground capture names, with the PID and
 * start marker the host measured; null for a shell, an unrecognized program, an ambiguous group,
 * an unverifiable capture or a different incarnation.
 */
export function readRecognizedForegroundAgent(
  inspection: TerminalProcessInspection | null | undefined,
  incarnationId: string | null
): { agent: string; pid: number; startTime: string } | null {
  const evidence =
    inspection && 'foregroundProcessEvidence' in inspection
      ? inspection.foregroundProcessEvidence
      : undefined
  if (
    !evidence ||
    evidence.verdict !== 'live' ||
    evidence.ptyIncarnationId !== incarnationId ||
    evidence.fence.platform !== 'posix' ||
    !evidence.fence.process
  ) {
    return null
  }
  const recognized = recognizeAgentProcess(evidence.processName)
  return recognized
    ? {
        agent: recognized.agent,
        pid: evidence.fence.process.pid,
        startTime: evidence.fence.process.startTime
      }
    : null
}

/** A fenced capture of this incarnation that names no recognized agent in front: the shell is back. */
export function isFencedShellForeground(
  inspection: TerminalProcessInspection | null | undefined,
  incarnationId: string | null
): boolean {
  const evidence =
    inspection && 'foregroundProcessEvidence' in inspection
      ? inspection.foregroundProcessEvidence
      : undefined
  return (
    evidence?.verdict === 'live' &&
    evidence.ptyIncarnationId === incarnationId &&
    evidence.fence.platform === 'posix' &&
    !evidence.fence.process &&
    !recognizeAgentProcess(evidence.processName)
  )
}
