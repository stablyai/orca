import type { GitHubProjectViewError } from '../../../shared/github/projects/project-result-types'
import { isGitHubOwnerSlug as isValidOwnerSlug } from '../../../shared/github/repositories/owner-slug'

// Shared owner rules differ from repo names; validate both before interpolating authenticated REST paths.
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+$/

const REPO_SLUG_RESERVED = new Set(['.', '..'])

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
