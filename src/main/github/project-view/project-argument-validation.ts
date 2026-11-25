import type { GitHubProjectViewError } from '../../../shared/github/projects/project-result-types'
import { isGitHubOwnerSlug as isValidOwnerSlug } from '../../../shared/github/repositories/owner-slug'
import { isGitHubRepositorySlug } from '../../../shared/github/repositories/repository-slug'

// Validate owner and repo before interpolating authenticated REST paths.

export function assertSlug(
  value: unknown,
  field: 'owner' | 'repo'
): { ok: true; slug: string } | { ok: false; error: GitHubProjectViewError } {
  const valid = field === 'owner' ? isValidOwnerSlug(value) : isGitHubRepositorySlug(value)
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
