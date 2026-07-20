// Why: `ghExecFileAsync` (WSL-aware, retry-enabled) is the single spawn site
// for gh calls. The legacy plain `execFileAsync` is NOT used here — routing
// every gh call through the runner gives us transient-5xx retry, WSL path
// translation, and a single hook point for future quota tracking.
import { acquire, release } from '../gh-utils'
import { extractExecError, ghExecFileAsync } from '../../git/runner'
import { rateLimitGuard, noteRateLimitSpend, type RateLimitBucketKind } from '../rate-limit'
import {
  classifyProjectError,
  driftError,
  errorsIndicateParentField,
  rateLimitedError,
  type GhGraphqlErrorShape
} from './error-classification'
import type {
  GitHubProjectParentIssue,
  GitHubProjectViewError
} from '../../../shared/github-project-types'

export { acquire, release, extractExecError, ghExecFileAsync, rateLimitGuard, noteRateLimitSpend }
export type { RateLimitBucketKind }
export { classifyProjectError, driftError, errorsIndicateParentField, rateLimitedError }
export type { GhGraphqlErrorShape }

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

// Why: shared by project-view.ts's normalizeItem (Phase 1b, table rows) and
// project-view/hierarchy.ts's normalizeHierarchyResponse (Phase 2, drawer
// hierarchy) — both read the same `{ number, title, url }` parent-issue
// shape off different GraphQL selections. Single source of truth so a
// future validation tightening doesn't silently drift between the two.
export function normalizeParentIssue(
  raw: { number?: number; title?: string; url?: string } | null | undefined
): GitHubProjectParentIssue | null {
  if (
    !raw ||
    typeof raw.number !== 'number' ||
    typeof raw.title !== 'string' ||
    typeof raw.url !== 'string'
  ) {
    return null
  }
  return { number: raw.number, title: raw.title, url: raw.url }
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
