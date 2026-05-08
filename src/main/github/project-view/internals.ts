/* eslint-disable max-lines -- Why: shared infrastructure for project-view —
slug validation, error classification, runGraphql/runRest, and rate-limit
synthesis. Co-located so the read and write paths observe identical
classification semantics. */
// Why: `ghExecFileAsync` (WSL-aware, retry-enabled) is the single spawn site
// for gh calls. The legacy plain `execFileAsync` is NOT used here — routing
// every gh call through the runner gives us transient-5xx retry, WSL path
// translation, and a single hook point for future quota tracking.
import { acquire, release } from '../gh-utils'
import { extractExecError, ghExecFileAsync } from '../../git/runner'
import { rateLimitGuard, noteRateLimitSpend, type RateLimitBucketKind } from '../rate-limit'
import type { GitHubProjectViewError } from '../../../shared/github-project-types'

export { acquire, release, extractExecError, ghExecFileAsync, rateLimitGuard, noteRateLimitSpend }
export type { RateLimitBucketKind }

// ─── Slug validation ──────────────────────────────────────────────────

// Why: GitHub usernames/org logins disallow `_`, `.`, leading `-`. Repo names
// are looser — they allow leading `_`, `.`, `-` (`.` and `..` reserved). We
// validate each separately so untrusted Project row data (`nameWithOwner`)
// can't become an arbitrary REST path while still accepting realistic repo
// names like `_internal` or `.github`.
const OWNER_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+$/
const REPO_SLUG_RESERVED = new Set(['.', '..'])

export function isValidOwnerSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && OWNER_SLUG_RE.test(value)
}

export function isValidRepoSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    REPO_SLUG_RE.test(value) &&
    !REPO_SLUG_RESERVED.has(value)
  )
}

// Backwards-compatible alias for callers that don't distinguish owner vs repo.
// Prefer `isValidOwnerSlug` / `isValidRepoSlug` at new call sites.
export function isValidSlug(value: unknown): value is string {
  return isValidOwnerSlug(value) || isValidRepoSlug(value)
}

export function assertSlug(
  value: unknown,
  field: 'owner' | 'repo'
): { ok: true; slug: string } | { ok: false; error: GitHubProjectViewError } {
  const valid = field === 'owner' ? isValidOwnerSlug(value) : isValidRepoSlug(value)
  if (!valid) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: `Invalid ${field}: "${String(value)}" is not a valid GitHub slug.`
      }
    }
  }
  return { ok: true, slug: value as string }
}

export function assertPositiveInt(
  value: unknown,
  field: string
): { ok: true; n: number } | { ok: false; error: GitHubProjectViewError } {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return {
      ok: false,
      error: {
        type: 'validation_error',
        message: `Invalid ${field}: must be a positive integer.`
      }
    }
  }
  return { ok: true, n: value }
}

export function validateSlugArgs(
  owner: unknown,
  repo: unknown
): { ok: true } | { ok: false; error: GitHubProjectViewError } {
  const o = assertSlug(owner, 'owner')
  if (!o.ok) {
    return { ok: false, error: o.error }
  }
  const r = assertSlug(repo, 'repo')
  if (!r.ok) {
    return { ok: false, error: r.error }
  }
  return { ok: true }
}

// ─── Error classification ──────────────────────────────────────────────

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

export function classifyProjectError(stderr: string, stdout: string): GitHubProjectViewError {
  const errors = extractGraphqlErrors(stderr, stdout)
  const s = stderr.toLowerCase()

  // Auth
  if (
    s.includes('authentication required') ||
    s.includes('not logged in') ||
    s.includes('gh auth login')
  ) {
    return {
      type: 'auth_required',
      message: 'Sign in to GitHub to load project tasks. Run `gh auth login`.'
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
      message:
        'GitHub project access needs additional scopes. Run `gh auth refresh -s project -s read:org -s repo`.'
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

// ─── Low-level gh api graphql invocation ───────────────────────────────

export type GraphqlVars = Record<string, string | number | boolean>

export async function runGraphql<T>(
  query: string,
  vars: GraphqlVars,
  cwd?: string
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: GitHubProjectViewError; raw: { stderr: string; stdout: string } }
> {
  const guard = rateLimitGuard('graphql')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard), raw: { stderr: '', stdout: '' } }
  }
  // Why: build argv as an array. `-f` for strings (including numbers passed
  // as strings), `-F` coerces to typed. We use `-f` uniformly and coerce in
  // the query via Int! casts, because `gh` can confuse empty strings.
  const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      args.push('-F', `${k}=${String(v)}`)
    } else {
      args.push('-f', `${k}=${v}`)
    }
  }
  await acquire()
  noteRateLimitSpend('graphql')
  try {
    const { stdout, stderr } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {})
    })
    try {
      const parsed = JSON.parse(stdout) as { data?: T; errors?: GhGraphqlErrorShape[] }
      if (parsed.errors && parsed.errors.length > 0) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout),
          raw: { stderr, stdout }
        }
      }
      if (parsed.data === undefined) {
        return {
          ok: false,
          error: driftError('response missing data'),
          raw: { stderr, stdout }
        }
      }
      return { ok: true, data: parsed.data }
    } catch (parseErr) {
      return {
        ok: false,
        error: driftError(
          `failed to parse response (${parseErr instanceof Error ? parseErr.message : String(parseErr)})`
        ),
        raw: { stderr, stdout }
      }
    }
  } catch (err) {
    // gh executable failures (non-zero exit). Read stderr/stdout from the
    // exec rejection's explicit fields — `err.message` may truncate stderr.
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return {
      ok: false,
      error: classifyProjectError(stderr, maybeStdout),
      raw: { stderr, stdout: maybeStdout }
    }
  } finally {
    release()
  }
}

export async function runRest<T>(
  args: string[],
  cwd?: string,
  bucket: RateLimitBucketKind = 'core',
  options?: { expectEmpty?: boolean }
): Promise<{ ok: true; data: T } | { ok: false; error: GitHubProjectViewError }> {
  const guard = rateLimitGuard(bucket)
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRateLimitSpend(bucket)
  try {
    const { stdout, stderr } = await ghExecFileAsync(['api', ...args], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {})
    })
    // Why: 204/empty-body endpoints (DELETE label, DELETE comment) return no
    // body. Treat empty stdout as success rather than misclassifying the
    // unparseable response as 'unknown' — which the caller would otherwise
    // need to special-case and risks masking real failures whose stderr the
    // classifier also tags as 'unknown'.
    if (options?.expectEmpty && stdout.trim() === '') {
      return { ok: true, data: undefined as T }
    }
    try {
      return { ok: true, data: JSON.parse(stdout) as T }
    } catch {
      return {
        ok: false,
        error: { type: 'unknown', message: `Unexpected REST response: ${stderr.trim()}` }
      }
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout) }
  } finally {
    release()
  }
}
