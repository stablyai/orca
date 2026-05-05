// Best-effort classifier from a thrown value to the closed `error_class`
// enum on `agent_error`. The whole point is that the wire never carries a
// raw error message or stack — every transmitted error is bucketed into
// one of the enum members. Unknown shape → `'unknown'` rather than dropping
// the event; a non-zero `unknown` slice on the dashboard tells us the
// classifier needs another branch.
//
// `error_name` is the one free-ish string allowed alongside `error_class`,
// and even it is constrained to `AGENT_ERROR_NAME_WHITELIST`. Unmapped
// error names are simply omitted — the validator would otherwise drop the
// whole event because non-whitelisted enum values fail `safeParse`. We
// preserve `error_class` and let the optional `error_name` go.

import {
  AGENT_ERROR_NAME_WHITELIST,
  type AgentErrorName,
  type ErrorClass
} from '../../shared/telemetry-events'

export type ClassifiedError = {
  error_class: ErrorClass
  error_name?: AgentErrorName
}

const WHITELISTED_NAMES = new Set<string>(AGENT_ERROR_NAME_WHITELIST)

const NAME_TO_CLASS: readonly [AgentErrorName, ErrorClass][] = [
  ['NetworkTimeout', 'network_timeout'],
  ['AuthExpired', 'auth_expired'],
  ['RateLimited', 'rate_limited'],
  ['ProviderUnavailable', 'provider_unavailable'],
  ['ProviderErrorGeneric', 'provider_error_generic'],
  ['BinaryNotFound', 'binary_not_found'],
  ['BinaryVersionMismatch', 'binary_version_mismatch'],
  ['WorkspaceGone', 'workspace_gone'],
  ['UserCancelled', 'user_cancelled']
]

const CLASS_BY_NAME = new Map<string, ErrorClass>(NAME_TO_CLASS)

// Lowercase substrings that map a freeform `Error` (`name === 'Error'`,
// thrown from an SDK or a child process) to a class bucket. Picks the first
// match in declaration order — narrower phrases come before more general
// ones (e.g., "rate limit" before "limit"). A catch-all is *not* needed:
// any unmapped error falls through to `'unknown'`.
const MESSAGE_HINTS: readonly { substr: string; cls: ErrorClass }[] = [
  { substr: 'etimedout', cls: 'network_timeout' },
  { substr: 'timed out', cls: 'network_timeout' },
  { substr: 'timeout', cls: 'network_timeout' },
  { substr: 'econnreset', cls: 'network_timeout' },
  { substr: 'econnrefused', cls: 'network_timeout' },
  { substr: 'enotfound', cls: 'network_timeout' },
  { substr: 'rate limit', cls: 'rate_limited' },
  { substr: 'too many requests', cls: 'rate_limited' },
  { substr: '429', cls: 'rate_limited' },
  { substr: 'unauthorized', cls: 'auth_expired' },
  { substr: '401', cls: 'auth_expired' },
  { substr: 'auth', cls: 'auth_expired' },
  { substr: 'unavailable', cls: 'provider_unavailable' },
  { substr: '503', cls: 'provider_unavailable' },
  { substr: '502', cls: 'provider_unavailable' },
  { substr: 'enoent', cls: 'binary_not_found' },
  { substr: 'not found', cls: 'binary_not_found' },
  { substr: 'cancel', cls: 'user_cancelled' },
  { substr: 'aborted', cls: 'user_cancelled' }
]

export function classifyError(err: unknown): ClassifiedError {
  if (err === null || err === undefined) {
    return { error_class: 'unknown' }
  }

  const errorName =
    typeof err === 'object' && err !== null && 'name' in err
      ? (err as { name?: unknown }).name
      : undefined
  const errorMessage =
    typeof err === 'object' && err !== null && 'message' in err
      ? (err as { message?: unknown }).message
      : undefined

  // Why: the strongest signal is a class name the caller already chose to
  // bucket the failure under. If the caller threw an error subclass whose
  // `name` matches a whitelist member, trust it.
  if (typeof errorName === 'string' && WHITELISTED_NAMES.has(errorName)) {
    const cls = CLASS_BY_NAME.get(errorName)
    if (cls !== undefined) {
      return { error_class: cls, error_name: errorName as AgentErrorName }
    }
  }

  // Fall back to substring inspection of `message` for plain `Error`s
  // surfaced from network / shell / SDK boundaries. The classifier never
  // returns the message itself; only the bucket and (for whitelisted name
  // matches above) the structured `error_name`.
  if (typeof errorMessage === 'string') {
    const lower = errorMessage.toLowerCase()
    for (const hint of MESSAGE_HINTS) {
      if (lower.includes(hint.substr)) {
        return { error_class: hint.cls }
      }
    }
  }

  return { error_class: 'unknown' }
}
