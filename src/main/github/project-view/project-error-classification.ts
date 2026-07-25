// Why: turns raw gh stderr/stdout into the typed GitHubProjectViewError the
// renderer can act on (auth vs scope vs rate limit vs drift), shared by the
// project-view read and mutation paths.
import type { GitHubProjectViewError } from '../../../shared/github-project-types'
import { githubProjectHost } from '../../../shared/github-project-identity'

export type GhGraphqlErrorShape = {
  type?: string
  message?: string
  path?: (string | number)[]
  extensions?: { code?: string }
}

export function extractGraphqlErrors(stderr: string, stdout: string): GhGraphqlErrorShape[] {
  // `gh api graphql` prints the response JSON to stdout even on GraphQL
  // errors, and the stderr carries a summary. Try stdout first; if parsing
  // fails, fall back to stderr.
  const sources = [stdout, stderr]
  for (const src of sources) {
    if (!src) {
      continue
    }
    try {
      const parsed = JSON.parse(src) as { errors?: GhGraphqlErrorShape[] }
      if (parsed.errors && parsed.errors.length > 0) {
        return parsed.errors
      }
    } catch {
      // not JSON — continue
    }
  }
  return []
}

export function errorsIndicateParentField(errors: GhGraphqlErrorShape[], stderr: string): boolean {
  const lower = stderr.toLowerCase()
  // Preview-header shape: gh returns a 4xx with "preview" in the message.
  if (lower.includes('preview') && lower.includes('parent')) {
    return true
  }
  return errors.some((e) => {
    const type = (e.type ?? '').toUpperCase()
    if (type === 'FIELD_NOT_FOUND' || type === 'UNDEFINED_FIELD' || type === 'FIELD_ERRORS') {
      const tail = e.path?.at(-1)
      if (tail === 'parent') {
        return true
      }
      // FIELD_ERRORS often omits `path`; match on message for the parent field.
      if ((e.message ?? '').toLowerCase().includes('parent')) {
        return true
      }
    }
    return false
  })
}

export function classifyProjectError(
  stderr: string,
  stdout: string,
  host?: string
): GitHubProjectViewError {
  const errors = extractGraphqlErrors(stderr, stdout)
  const s = stderr.toLowerCase()
  const selectedHost = githubProjectHost(host)

  // Auth
  if (
    s.includes('authentication required') ||
    s.includes('not logged in') ||
    s.includes('gh auth login')
  ) {
    return {
      type: 'auth_required',
      message: `Sign in to GitHub to load project tasks. Run \`gh auth login --hostname ${selectedHost}\`.`
    }
  }
  // Scope
  if (
    s.includes('missing required scope') ||
    s.includes('your token has not been granted') ||
    (s.includes('resource not accessible') && (s.includes('project') || s.includes('scope')))
  ) {
    return {
      type: 'scope_missing',
      message: `GitHub project access needs additional scopes. Run \`gh auth refresh --hostname ${selectedHost} -s project -s read:org -s repo\`.`
    }
  }
  // Rate limit
  if (s.includes('rate limit') || s.includes('api rate limit exceeded')) {
    return { type: 'rate_limited', message: 'GitHub rate limit hit. Try again in a few minutes.' }
  }
  // Network — checked BEFORE not_found because DNS failures surface as
  // "could not resolve host", which would otherwise be partially matched by
  // the not_found branch's "could not resolve" check. Substring matching here
  // is a one-way trapdoor: a real GraphQL "Could not resolve to a User…"
  // error always contains "to a", so we tighten the not_found check below to
  // require that token.
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host') ||
    s.includes('dial tcp')
  ) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  // Not found
  if (
    s.includes('http 404') ||
    errors.some((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND') ||
    // Why: GitHub uses "to an" for vowel-leading types ("to an Issue", "to
    // an Organization") and "to a" otherwise. The previous singular-only
    // check missed the "an" variants when gh emits only the stderr summary
    // without a structured GraphQL error array. See bug-scan finding 3.
    /could not resolve to an? /.test(s)
  ) {
    const firstNotFound = errors.find((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND')
    return {
      type: 'not_found',
      message: 'Project or view not found.',
      details: firstNotFound
        ? { path: firstNotFound.path, code: firstNotFound.extensions?.code }
        : undefined
    }
  }
  // Validation
  if (s.includes('http 422') || s.includes('validation failed')) {
    return { type: 'validation_error', message: `Invalid request — ${stderr.trim()}` }
  }
  // GraphQL error with structured info
  if (errors.length > 0) {
    const first = errors[0]
    return {
      type: 'unknown',
      message: first.message ?? 'Unknown GraphQL error.',
      details: { path: first.path, code: first.extensions?.code }
    }
  }
  // Why: don't leak full stderr to the UI — it can include verbose request
  // dumps with header diagnostics. Truncate to the first non-empty line and
  // cap length so unexpected diagnostics stay readable but bounded.
  const firstLine =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const safe = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  return {
    type: 'unknown',
    message: safe ? `GitHub request failed: ${safe}` : 'GitHub request failed.'
  }
}

export function driftError(
  reason: string,
  details?: { path?: (string | number)[]; code?: string }
): GitHubProjectViewError {
  return { type: 'schema_drift', message: `Could not read this project view: ${reason}.`, details }
}

// Why: the rate-limit circuit breaker short-circuits before we spawn `gh`
// when the cached snapshot says we're below the safety floor. Synthesize the
// same `rate_limited` error shape as the post-hoc classifier so the UI path
// is unchanged. We DO NOT fail open here when there's no cached snapshot —
// rateLimitGuard already handles that case (returns `blocked:false`).
export function rateLimitedError(blocked: {
  remaining: number
  limit: number
  resetAt: number
}): GitHubProjectViewError {
  const resetIn = Math.max(0, blocked.resetAt - Math.floor(Date.now() / 1000))
  const mins = Math.ceil(resetIn / 60)
  return {
    type: 'rate_limited',
    message: `GitHub rate limit nearly exhausted (${blocked.remaining}/${blocked.limit} left). Resets in ~${mins}m.`
  }
}
