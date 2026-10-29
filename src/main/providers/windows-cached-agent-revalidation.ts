import { isShellProcess } from '../../shared/shell-process-detection'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { AgentForegroundProcessResolution } from './agent-foreground-process'

/** Unanchored job evidence may outlive console agents; cap it at five renderer confirm ladders (30s).
 * Refresh on every positive recognition so the limit never times out a confirmed live agent. */
export const WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS = 30_000

export function canRevalidateCachedAgentWithoutScan(
  cachedAgentName: string | null,
  fallbackProcess: string | null
): boolean {
  return (
    cachedAgentName !== null &&
    fallbackProcess !== null &&
    // Generic wrappers can outlive agents; only unreliable shell fallbacks may bridge through this cache.
    isShellProcess(fallbackProcess)
  )
}

export type WindowsCachedAgentJobVerdict =
  /** Missing native capability: scans decide; distinct from an attempted but unavailable read. */
  | 'unsupported'
  /** Anchor pid alive in the job, recently confirmed: identity stands, no scan. */
  | 'confirmed'
  /** Anchor pid alive but past the age bound: scan for drift; a silent scan keeps it. */
  | 'recheck'
  /** The shell alone in a complete job read: no successor is possible, retire. */
  | 'exited'
  /** Other job members may be a restarted successor; keep only age-bounded identity until a scan settles it. */
  | 'anchor-exited'
  /** No anchor; a non-shell member exists and the bound has not elapsed: identity stands. */
  | 'unproven'
  /** No anchor and the bound elapsed: the superset answer stops standing in for a scan. */
  | 'expired'
  /** No job answer: unverifiable per ssh-execution-boundary.md, never exit proof. */
  | 'unavailable'

/** Complete inescapable-job membership proves anchor liveness/exit; unanchored members only supply age-bounded evidence. */
export function judgeCachedAgentJobEvidence(args: {
  jobProcessIds: ReadonlySet<number> | null
  jobSupported?: boolean
  shellPid: number
  anchorProcessId: number | null
  identityAgeMs: number
}): WindowsCachedAgentJobVerdict {
  if (args.jobProcessIds === null) {
    return args.jobSupported === false ? 'unsupported' : 'unavailable'
  }
  const withinAgeBound = args.identityAgeMs <= WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS
  // A shell-pid "anchor" proves nothing about a child; treat it as unanchored.
  if (args.anchorProcessId !== null && args.anchorProcessId !== args.shellPid) {
    if (!args.jobProcessIds.has(args.anchorProcessId)) {
      return args.jobProcessIds.size <= 1 ? 'exited' : 'anchor-exited'
    }
    return withinAgeBound ? 'confirmed' : 'recheck'
  }
  if (args.jobProcessIds.size <= 1) {
    return 'exited'
  }
  return withinAgeBound ? 'unproven' : 'expired'
}

/** Decision authority comes from fresh recognition or a known anchor not yet proved gone. */
export function reconcileWindowsAgentDecision(
  resolution: AgentForegroundProcessResolution,
  verdict: WindowsCachedAgentJobVerdict,
  anchor: { processName: string; pid: number | null } | null,
  shellPid: number
): string | null {
  if (resolution.available && recognizeAgentProcessFromCommandLine(resolution.processName ?? '')) {
    return resolution.processName
  }
  if (
    anchor?.pid != null &&
    anchor.pid !== shellPid &&
    recognizeAgentProcessFromCommandLine(anchor.processName) &&
    !resolution.anchorPidForeign &&
    (verdict === 'confirmed' ||
      verdict === 'recheck' ||
      verdict === 'unavailable' ||
      verdict === 'unsupported')
  ) {
    return anchor.processName
  }
  return resolution.available ? resolution.processName : null
}
