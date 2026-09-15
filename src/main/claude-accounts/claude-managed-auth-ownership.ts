/**
 * Why: the Claude managed-auth gate answers two different questions and callers
 * must act on them differently. `untrusted` is a *successful observation* that
 * failed a trust check (or a definitive absence, where absence is the verdict);
 * `indeterminate` means the storage could not be read at all, so the directory
 * may be perfectly valid and callers must refuse to act without erasing durable
 * state.
 *
 * Claude had no typed errors at all before STA-5674 — every failure arrived as a
 * bare `Error` with a trust-flavoured string — so `cleanupFailedAdd` could not
 * tell "this is not your directory" from "we could not look", and deleted the
 * account on both. Mirrors the Codex lane's `HostCodexManagedHomeVerdict`
 * vocabulary deliberately; merging the two lanes into one module is STA-5616.
 */
export type ClaudeManagedAuthVerdict =
  | { kind: 'owned'; authPath: string }
  | { kind: 'untrusted'; reason: string }
  | { kind: 'indeterminate'; error: unknown }

export const MISSING_MANAGED_AUTH_MESSAGE = 'Managed Claude auth directory does not exist on disk.'
export const UNTRUSTED_MANAGED_AUTH_MESSAGE = 'Managed Claude auth storage is not owned by Orca.'
export const OUTSIDE_MANAGED_AUTH_ROOT_MESSAGE =
  'Managed WSL Claude auth storage is outside Orca account storage.'

/** Thrown for a proven trust failure; safe to refuse and to clean up on. */
export class UntrustedManagedClaudeAuthError extends Error {}

/**
 * Thrown when the storage could not be read. Callers must refuse the operation
 * and leave persisted settings, credentials, and managed directories untouched.
 */
export class ManagedClaudeAuthTemporarilyUnavailableError extends Error {
  constructor(
    message = 'Claude account files are temporarily locked. Retry in a moment.',
    options?: { cause?: unknown }
  ) {
    super(message, options)
  }
}

/** Throwing wrapper for the write paths that must never proceed on unproven storage. */
export function assertOwnedClaudeManagedAuthPath(verdict: ClaudeManagedAuthVerdict): string {
  if (verdict.kind === 'owned') {
    return verdict.authPath
  }
  if (verdict.kind === 'untrusted') {
    throw new UntrustedManagedClaudeAuthError(verdict.reason)
  }
  throw new ManagedClaudeAuthTemporarilyUnavailableError(undefined, { cause: verdict.error })
}

const MAX_CAUSE_DEPTH = 8

/**
 * True when `error`, or anything it wraps, reports storage Orca could not read.
 *
 * Walks `cause` because the failure crosses several layers before reaching the
 * caller that decides whether deleting is authorised, and traverses any object
 * rather than only `Error` -- an IPC or dependency boundary can reject with a
 * plain wrapper around the typed error.
 *
 * A value it cannot inspect answers `true`, not `false`: the question is whether
 * the failure is *proven* dispositive, and a shape that throws when read has
 * proven nothing. Deletion requires proof, so the unreadable case must land on
 * the side that keeps the directory.
 */
export function isUnprovenManagedClaudeAuthError(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      return false
    }
    if (seen.has(current)) {
      // A cycle means every reachable link has already been inspected, so this
      // is a completed answer rather than an abandoned one.
      return false
    }
    seen.add(current)
    try {
      if (current instanceof ManagedClaudeAuthTemporarilyUnavailableError) {
        return true
      }
      current = (current as { cause?: unknown }).cause
    } catch {
      // `instanceof` runs a prototype lookup, which a Proxy can trap and throw
      // from, and so can a `cause` accessor. Either way the shape defeated
      // inspection.
      return true
    }
  }
  // Depth exhausted: unlike a cycle, links remain that were never looked at.
  return true
}
