import { isShellProcess } from '../../shared/shell-process-detection'

/**
 * How long a cached agent identity may survive on job evidence alone.
 *
 * The job is a SUPERSET of the console: it keeps console-detached descendants,
 * so "something besides the shell is alive" cannot tell a working agent from a
 * leftover. Any pane that keeps one -- and whose fallback name reads as a shell
 * -- would otherwise pin a dead agent's name forever (#9258's bug, reached by a
 * new route). Age is the tiebreak.
 *
 * The invariant both callers must preserve: every successful recognition resets
 * the clock, so this can only expire an identity no scan has confirmed for this
 * long. It is never a timeout on a live agent.
 *
 * 5x the renderer's 6s confirm ladder, and bounded above by the fact that a
 * stale cache also pins the refresh at the 1s TTL until it clears.
 */
export const WINDOWS_DETACHED_DESCENDANT_IDENTITY_MAX_AGE_MS = 30_000

/** Whether job membership can revalidate a cached agent without a process scan. */
export function canRevalidateCachedAgentWithoutScan(
  cachedAgentName: string | null,
  fallbackProcess: string | null
): boolean {
  return (
    cachedAgentName !== null &&
    fallbackProcess !== null &&
    // Why: a generic wrapper may outlive the agent; only the shell fallback is
    // the known unreliable Windows exit signal this cache is allowed to bridge.
    isShellProcess(fallbackProcess)
  )
}

export type WindowsCachedAgentJobVerdict =
  /**
   * This build's node-pty has no job exports, so there is no job evidence to
   * weigh -- and every shipped Windows release is still such a build (#16059).
   * Distinct from 'unavailable': that means "we could have asked and could not",
   * which must never retire. This means "there is nothing to ask", so the
   * authoritative scan decides alone, exactly as it does off Windows.
   */
  | 'unsupported'
  /** Anchor pid alive in the job, recently confirmed: identity stands, no scan. */
  | 'confirmed'
  /** Anchor pid alive but past the age bound: scan for drift; a silent scan keeps it. */
  | 'recheck'
  /** The shell alone in a complete job read: no successor is possible, retire. */
  | 'exited'
  /**
   * The anchor pid left the job but another member remains — a leftover, or
   * the agent's restarted successor. The name may only survive as unanchored,
   * age-bounded evidence; an available scan settles it (a degraded one must
   * not read as an exit).
   */
  | 'anchor-exited'
  /** No anchor; a non-shell member exists and the bound has not elapsed: identity stands. */
  | 'unproven'
  /** No anchor and the bound elapsed: the superset answer stops standing in for a scan. */
  | 'expired'
  /** No job answer: unverifiable per ssh-execution-boundary.md, never exit proof. */
  | 'unavailable'

/**
 * Weigh a cached agent identity against the pane's job membership.
 *
 * The job list is complete when non-null (the native read grows its buffer
 * until every pid fits), so an anchor pid it lacks has provably exited — a job
 * is inescapable once joined. Without an anchor the job is only a superset of
 * the console (it keeps console-detached descendants), so `size > 1` cannot
 * tell a working agent from a leftover and the age bound decides instead.
 */
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
