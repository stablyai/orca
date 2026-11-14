import type { PRInfo } from '../../../../src/shared/github/pull-requests/pull-request-types'
import type { HostReadIntent } from '../../query/host-read-intent'
import type { GitHubPrForBranchOutcome } from './github-pr-read-reply-schema'

/** A PR read; `retryAfterMs` asks for another read that soon while the host revalidates, and
 *  `revalidationOnly` says the host sent no answer at all, so nothing shown may change. */
export type GitHubPrForBranchRead =
  | { ok: true; result: PRInfo | null; retryAfterMs?: number; revalidationOnly?: true }
  | { ok: false; error: string }

// Open reads keep the host's short reuse of its own lookup; a return to the app reads fresh; the
// screen's timer lets the host answer from its last read and say when to read again.
export function prForBranchIntentParams(args: { refresh?: boolean; intent?: HostReadIntent }) {
  if (args.refresh) {
    return { userRefresh: true }
  }
  if (args.intent === 'foreground') {
    return { reason: 'active' as const }
  }
  if (args.intent === 'background') {
    return { reason: 'swr' as const, acceptRevalidationOnly: true }
  }
  return {}
}

export function resolveGithubPrForBranchOutcome(
  outcome: GitHubPrForBranchOutcome | null
): Omit<Extract<GitHubPrForBranchRead, { ok: true }>, 'ok'> {
  if (outcome === null) {
    return { result: null }
  }
  switch (outcome.kind) {
    case 'upstream-error':
      throw new Error(outcome.message)
    case 'revalidating':
      return { result: null, retryAfterMs: outcome.retryAfterMs, revalidationOnly: true }
    case 'no-pr':
      return { result: null, retryAfterMs: outcome.retryAfterMs }
    case 'found':
      return outcome.retryAfterMs === undefined
        ? { result: outcome.pr }
        : { result: outcome.pr, retryAfterMs: outcome.retryAfterMs }
  }
}
