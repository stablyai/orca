import { acquire, release } from '../gh-utils'
import { isGitHubOwnerSlug } from '../../../shared/github/owner-slug'
import { extractExecError, ghExecFileAsync } from '../../git/runner'
import {
  repositoryRateLimitGuard,
  noteRepositoryRateLimitSpend,
  type RateLimitBucketKind
} from '../rate-limit'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { githubProjectHost } from '../../../shared/github/project-identity'
import { isDefaultGitHubHost } from '../../../shared/github/repository-identity-key'
import { isGitHubHostAuthenticatedForGlobalCli } from '../github-enterprise-repository'
import {
  classifyProjectError,
  driftError,
  rateLimitedError,
  type GhGraphqlError
} from './project-error-classification'

export {
  acquire,
  release,
  extractExecError,
  ghExecFileAsync,
  repositoryRateLimitGuard,
  noteRepositoryRateLimitSpend
}
export type { RateLimitBucketKind }

/** Project View uses ambient login, independently of Repo.ghAccount; pin Enterprise hosts explicitly. */
export type ProjectGhExecOptions = { cwd?: string; host?: string }

// Owner/project calls have no repository slug, so pin their host directly.
export function projectGhExecOptions(host: string | undefined): ProjectGhExecOptions {
  return { host: githubProjectHost(host) }
}

export async function projectHostAuthenticationError(
  host: string | undefined
): Promise<GitHubProjectViewError | null> {
  const selectedHost = githubProjectHost(host)
  if (
    isDefaultGitHubHost(selectedHost) ||
    (await isGitHubHostAuthenticatedForGlobalCli(selectedHost))
  ) {
    return null
  }
  // Verify pasted hosts before sending ambient Enterprise credentials.
  return {
    type: 'auth_required',
    message: `GitHub CLI is not authenticated to ${selectedHost}. Run gh auth login --hostname ${selectedHost}.`,
    host: selectedHost
  }
}

// Shared owner rules differ from repo names; validate both before interpolating authenticated REST paths.
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+$/
const REPO_SLUG_RESERVED = new Set(['.', '..'])

export function isValidOwnerSlug(value: unknown): value is string {
  return isGitHubOwnerSlug(value)
}

export function isValidRepoSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    REPO_SLUG_RE.test(value) &&
    !REPO_SLUG_RESERVED.has(value)
  )
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
        message: `Invalid ${field}: "${String(value)}" is not a valid GitHub slug.`,
        reason: 'invalid_slug',
        detail: field,
        value: String(value)
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
        message: `Invalid ${field}: must be a positive integer.`,
        reason: 'invalid_positive_integer',
        detail: field
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

export type GraphqlVars = Record<string, string | number | boolean>

export async function runGraphql<T>(
  query: string,
  vars: GraphqlVars,
  exec?: ProjectGhExecOptions
): Promise<
  | { ok: true; data: T }
  | { ok: false; error: GitHubProjectViewError; raw: { stderr: string; stdout: string } }
> {
  const authError = await projectHostAuthenticationError(exec?.host)
  if (authError) {
    return { ok: false, error: authError, raw: { stderr: '', stdout: '' } }
  }
  // Enterprise traffic has separate quota from the shared github.com snapshot.
  const guard = repositoryRateLimitGuard({ host: exec?.host }, 'graphql')
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard), raw: { stderr: '', stdout: '' } }
  }
  // Use typed -F for numbers/booleans and literal -f for strings, including empty strings.
  const args: string[] = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'number' || typeof v === 'boolean') {
      args.push('-F', `${k}=${String(v)}`)
    } else {
      args.push('-f', `${k}=${v}`)
    }
  }
  await acquire()
  noteRepositoryRateLimitSpend({ host: exec?.host }, 'graphql')
  try {
    const { stdout, stderr } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      ...(exec?.cwd ? { cwd: exec.cwd } : {}),
      ...(exec?.host ? { host: exec.host } : {})
    })
    try {
      const parsed: { data?: T; errors?: GhGraphqlError[] } = JSON.parse(stdout)
      if (parsed.errors && parsed.errors.length > 0) {
        return {
          ok: false,
          error: classifyProjectError(stderr, stdout, exec?.host),
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
    // Explicit streams preserve diagnostics that Error.message may truncate.
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return {
      ok: false,
      error: classifyProjectError(stderr, maybeStdout, exec?.host),
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
  options?: { expectEmpty?: boolean; host?: string }
): Promise<{ ok: true; data: T } | { ok: false; error: GitHubProjectViewError }> {
  const authError = await projectHostAuthenticationError(options?.host)
  if (authError) {
    return { ok: false, error: authError }
  }
  // Enterprise traffic has separate quota from the shared github.com snapshot.
  const guard = repositoryRateLimitGuard({ host: options?.host }, bucket)
  if (guard.blocked) {
    return { ok: false, error: rateLimitedError(guard) }
  }
  await acquire()
  noteRepositoryRateLimitSpend({ host: options?.host }, bucket)
  try {
    const { stdout, stderr } = await ghExecFileAsync(['api', ...args], {
      encoding: 'utf-8',
      ...(cwd ? { cwd } : {}),
      ...(options?.host ? { host: options.host } : {})
    })
    // Successful DELETE endpoints can return no body; do not misclassify empty stdout as a parse failure.
    if (options?.expectEmpty && stdout.trim() === '') {
      return { ok: true, data: undefined as T }
    }
    try {
      return { ok: true, data: JSON.parse(stdout) as T }
    } catch {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: `Unexpected REST response: ${stderr.trim()}`,
          reason: 'unexpected_rest_response',
          detail: stderr.trim()
        }
      }
    }
  } catch (err) {
    const { stderr, stdout: maybeStdout } = extractExecError(err)
    return { ok: false, error: classifyProjectError(stderr, maybeStdout, options?.host) }
  } finally {
    release()
  }
}
