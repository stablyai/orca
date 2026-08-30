import type * as pty from 'node-pty'
import { resolveAgentForegroundProcessWithAvailability } from '../../providers/agent-foreground-process'
import {
  judgeCachedAgentJobEvidence,
  WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS
} from '../../providers/windows-cached-agent-revalidation'
import {
  isWindowsPtyJobReadable,
  readWindowsPtyJobProcessIds
} from '../../providers/windows-pty-job-membership'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../../shared/shell-process-detection'

export const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
// Why 30s: comfortably above the slowest idle refresh cadence (15s on Windows)
// so a healthy idle pane always holds corroboration, while a pane whose scans
// stopped settling loses shell-exit authority within seconds.
const SHELL_TITLE_SCAN_CORROBORATION_MAX_AGE_MS = 30_000

// `pid` anchors the identity to the row that proved it (null when ambiguous).
export type CachedAgentForeground = {
  processName: string
  pid: number | null
  refreshedAt: number
}

/** Outcome of the most recently settled identity scan. `sawAgent` is only
 *  meaningful when `available` — an unavailable scan observed nothing.
 *  `startedAt` dates the process snapshot the scan read; `at` dates the answer. An
 *  agent that appears between the two is invisible to the snapshot, so ordering
 *  against other evidence must use `startedAt`. */
export type ForegroundScanSettlement = {
  at: number
  startedAt: number
  available: boolean
  sawAgent: boolean
}

export type ForegroundIdentityState = {
  cachedAgentForeground: CachedAgentForeground | null
  startupAgentForeground: { processName: string; expiresAt: number } | null
  lastScanSettlement: ForegroundScanSettlement | null
  refreshInFlight: boolean
  lastRefreshStartedAt: number
  lastOutputAt: number
}

export function getActiveStartupAgent(
  state: ForegroundIdentityState,
  now = Date.now()
): { processName: string; expiresAt: number } | null {
  if (!state.startupAgentForeground) {
    return null
  }
  if (now > state.startupAgentForeground.expiresAt) {
    state.startupAgentForeground = null
    return null
  }
  return state.startupAgentForeground
}

/**
 * A shell-shaped title is exit evidence only when a completed scan agrees the
 * pane is idle. node-pty's POSIX title read silently falls back to the spawned
 * shell file when the native read fails, so under the same distress that
 * degrades the scan, "title == shell" observes nothing — and a scan that last
 * saw the agent cannot corroborate its absence either.
 *
 * `agentEvidence` outdates the settlement: the synchronous title fast path stamps a
 * recognized agent without running a scan, so an agent-free settlement can still be
 * inside the window while an agent that started after it is live. Compared against
 * `startedAt`, not `at` — a scan that settles after the agent appeared still read a
 * process table from before it.
 *
 * Strictly newer, because equal stamps are unordered rather than simultaneous: Date.now()
 * cannot separate two events inside one millisecond, so a table captured in the agent's own
 * millisecond may or may not have seen it. Only a scan that demonstrably started after the
 * agent was stamped can speak for its absence; the tie keeps the agent.
 */
export function isShellTitleCorroborated(
  settlement: ForegroundScanSettlement | null,
  now: number,
  agentEvidence: CachedAgentForeground | null
): boolean {
  return (
    settlement !== null &&
    settlement.available &&
    !settlement.sawAgent &&
    now - settlement.at <= SHELL_TITLE_SCAN_CORROBORATION_MAX_AGE_MS &&
    !agentEvidenceOutdatesScan(agentEvidence, settlement.startedAt)
  )
}

/**
 * Whether the pane's agent identity postdates the process table a scan read. Such a scan cannot
 * speak for that agent's absence: the table it sampled at `scanStartedAt` may never have had the
 * chance to contain it, so its silence is not an observation.
 *
 * Strictly newer, because equal stamps are unordered rather than simultaneous: Date.now() cannot
 * separate two events inside one millisecond, so a table captured in the agent's own millisecond
 * may or may not have seen it. An unknown order is not proof of an exit; the tie keeps the agent.
 */
export function agentEvidenceOutdatesScan(
  agentEvidence: CachedAgentForeground | null,
  scanStartedAt: number
): boolean {
  return agentEvidence !== null && agentEvidence.refreshedAt >= scanStartedAt
}

/**
 * The throttled async identity scan behind the tracker's synchronous reads:
 * resolves the pane's real foreground agent through the process table, keeps
 * or retires the cached identity, and records how its last scan settled so
 * the sync read can tell an observed idle shell from a degraded read.
 */
export function createForegroundIdentityRefresh(args: {
  process: pty.IPty
  state: ForegroundIdentityState
  contextPaths: string[]
  isDead: () => boolean
  getFallbackProcess: () => string | null
  shouldInspectFallback: (fallbackProcess: string | null) => boolean
}): (fallbackProcess: string | null) => void {
  const proc = args.process
  const state = args.state
  return (fallbackProcess) => {
    if (args.isDead() || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !args.shouldInspectFallback(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgent(state, now) && !state.cachedAgentForeground
    const retryMs = !idleNoEvidenceShell
      ? FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' &&
          now - state.lastOutputAt > SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (state.refreshInFlight || now - state.lastRefreshStartedAt < retryMs) {
      return
    }
    state.refreshInFlight = true
    state.lastRefreshStartedAt = now
    // Why not `now` everywhere below: the POSIX process table is a process-wide cache
    // shared by every pane, so this scan can be answered from one another pane started
    // earlier. `now` is when this pane ASKED; the table can be a TTL older, and an agent
    // that began in between is simply missing from it. Replaced by the measured scan
    // start once the resolver reports one.
    let scanStartedAt = now
    const identityOlderThan = (ms: number): boolean =>
      state.cachedAgentForeground !== null &&
      Date.now() - state.cachedAgentForeground.refreshedAt > ms
    const retireStaleForegroundIdentity = ({ onlyWhenAged = false } = {}): void => {
      // This scan sampled the process table at `scanStartedAt`; an identity stamped at or
      // after that is evidence it may never have had a chance to see, so it cannot be retired
      // on this answer. Equal stamps are unordered, not simultaneous — Date.now() cannot say
      // which came first inside a millisecond — and an unknown order is not proof of an exit.
      if (agentEvidenceOutdatesScan(state.cachedAgentForeground, scanStartedAt)) {
        return
      }
      const currentFallbackProcess = args.getFallbackProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgent(state) &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess) &&
        (!onlyWhenAged || identityOlderThan(WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS))
      ) {
        state.cachedAgentForeground = null
        state.startupAgentForeground = null
      } else if (
        identityOlderThan(FOREGROUND_AGENT_CACHE_TTL_MS) &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        state.cachedAgentForeground = null
      }
    }
    const anchor = state.cachedAgentForeground
    void resolveAgentForegroundProcessWithAvailability(proc.pid, fallbackProcess, {
      contextPaths: args.contextPaths,
      ...(anchor?.pid != null
        ? { anchorProcessId: anchor.pid, anchorProcessName: anchor.processName }
        : {})
    })
      .then<string | void>(
        ({ processName, processId, available, anchorPidForeign, tableScanStartedAtMs }) => {
          scanStartedAt = tableScanStartedAtMs ?? now
          state.lastScanSettlement = {
            at: Date.now(),
            startedAt: scanStartedAt,
            available,
            sawAgent: available && recognizeAgentProcess(processName) !== null
          }
          if (args.isDead() || !available) {
            return
          }
          if (!processName || !recognizeAgentProcess(processName)) {
            if (
              process.platform === 'win32' &&
              fallbackIsShell &&
              state.cachedAgentForeground !== null
            ) {
              // Job, not console: needs no console attachment, so no fork (#10857).
              const verdict = judgeCachedAgentJobEvidence({
                jobProcessIds: readWindowsPtyJobProcessIds(proc),
                jobSupported: isWindowsPtyJobReadable(),
                shellPid: proc.pid,
                anchorProcessId: state.cachedAgentForeground.pid,
                identityAgeMs: Date.now() - state.cachedAgentForeground.refreshedAt
              })
              // Unverifiable is never exit proof (ssh-execution-boundary.md): hold.
              if (verdict === 'unavailable') {
                return
              }
              if (verdict === 'unsupported') {
                // No job to consult on this build, and the scan that got here was
                // available and found no agent. Trust it, as every other platform
                // does, rather than holding a dead name forever (#16059).
                retireStaleForegroundIdentity()
                return
              }
              if (verdict === 'confirmed' || verdict === 'recheck') {
                if (anchorPidForeign === true) {
                  // The scan proved the pid recycled to a non-agent: retire now.
                  retireStaleForegroundIdentity()
                  return
                }
                // The anchor pid is still in the job: the scan lost the row, not
                // the agent. Restamp so a live agent never ages out (#9258).
                state.cachedAgentForeground = {
                  ...state.cachedAgentForeground,
                  refreshedAt: Date.now()
                }
                return
              }
              if (verdict === 'exited' || verdict === 'anchor-exited') {
                // Safe mid-restart: an available scan already found no agent.
                retireStaleForegroundIdentity()
                return
              }
              // Unanchored superset evidence cannot tell a working agent from a
              // leftover; the age bound settles it.
              retireStaleForegroundIdentity({ onlyWhenAged: true })
              return
            }
            retireStaleForegroundIdentity()
            return
          }
          state.cachedAgentForeground = {
            processName,
            pid: processId ?? null,
            refreshedAt: Date.now()
          }
          state.startupAgentForeground = null
          return processName
        }
      )
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
        state.lastScanSettlement = {
          at: Date.now(),
          startedAt: scanStartedAt,
          available: false,
          sawAgent: false
        }
      })
      .finally(() => {
        state.refreshInFlight = false
      })
  }
}
