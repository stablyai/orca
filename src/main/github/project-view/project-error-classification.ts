import type { OptionalProjectItemField } from './project-view-cache'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { githubProjectHost } from '../../../shared/github/project-identity'

export type GhGraphqlError = {
  type?: string
  message?: string
  path?: (string | number)[]
  extensions?: { code?: string; fieldName?: string; typeName?: string }
}

export function extractGraphqlErrors(stderr: string, stdout: string): GhGraphqlError[] {
  // GraphQL errors can arrive as JSON on stdout even with nonzero exit; try it before stderr.
  const sources = [stdout, stderr]
  for (const src of sources) {
    if (!src) {
      continue
    }
    try {
      const parsed: { errors?: GhGraphqlError[] } = JSON.parse(src)
      if (parsed.errors && parsed.errors.length > 0) {
        return parsed.errors
      }
    } catch {
      // Try the next diagnostic stream.
    }
  }
  return []
}

export function unsupportedItemFieldsFromErrors(
  errors: GhGraphqlError[],
  stderr: string
): OptionalProjectItemField[] {
  const unsupported = new Set<OptionalProjectItemField>()
  if (/preview/i.test(stderr) && /\bparent\b/i.test(stderr)) {
    unsupported.add('parent')
  }
  for (const error of errors) {
    const code = (error.type ?? error.extensions?.code ?? '').replace(/_/g, '').toUpperCase()
    const message = error.message ?? ''
    const missing =
      /doesn't exist|does not exist|cannot query field|unknown field|undefined field|no such type/i.test(
        message
      )
    if (
      !['FIELDNOTFOUND', 'UNDEFINEDFIELD', 'FIELDERRORS', 'UNDEFINEDTYPE'].includes(code) &&
      !(code === '' && missing)
    ) {
      continue
    }
    for (const field of ['parent', 'subIssuesSummary', 'linkedPullRequests'] as const) {
      const name = field === 'linkedPullRequests' ? 'ProjectV2ItemFieldPullRequestValue' : field
      if (
        error.path?.at(-1) === name ||
        error.extensions?.fieldName === name ||
        error.extensions?.typeName === name ||
        message
          .toLowerCase()
          .split(/[^a-z0-9_]+/)
          .includes(name.toLowerCase())
      ) {
        unsupported.add(field)
      }
    }
  }
  return [...unsupported]
}

export function classifyProjectError(
  stderr: string,
  stdout: string,
  host?: string
): GitHubProjectViewError {
  const errors = extractGraphqlErrors(stderr, stdout)
  const s = stderr.toLowerCase()
  const selectedHost = githubProjectHost(host)

  if (
    s.includes('authentication required') ||
    s.includes('not logged in') ||
    s.includes('gh auth login')
  ) {
    return {
      type: 'auth_required',
      message: `Sign in to GitHub to load project tasks. Run \`gh auth login --hostname ${selectedHost}\`.`,
      host: selectedHost
    }
  }
  if (
    s.includes('missing required scope') ||
    s.includes('your token has not been granted') ||
    (s.includes('resource not accessible') && (s.includes('project') || s.includes('scope')))
  ) {
    return {
      type: 'scope_missing',
      message: `GitHub project access needs additional scopes. Run \`gh auth refresh --hostname ${selectedHost} -s project -s read:org -s repo\`.`,
      host: selectedHost
    }
  }
  if (s.includes('rate limit') || s.includes('api rate limit exceeded')) {
    return { type: 'rate_limited', message: 'GitHub rate limit hit. Try again in a few minutes.' }
  }
  // DNS could-not-resolve-host overlaps missing-object wording; classify it before not-found.
  if (
    s.includes('timeout') ||
    s.includes('no such host') ||
    s.includes('network') ||
    s.includes('could not resolve host') ||
    s.includes('dial tcp')
  ) {
    return { type: 'network_error', message: 'Network error — check your connection.' }
  }
  if (
    s.includes('http 404') ||
    errors.some((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND') ||
    // GitHub uses to an for vowel-leading object types such as Issue and Organization.
    /could not resolve to an? /.test(s)
  ) {
    const firstNotFound = errors.find((e) => (e.type ?? '').toUpperCase() === 'NOT_FOUND')
    return {
      type: 'not_found',
      message: 'Project or view not found.',
      reason: 'project_or_view_not_found',
      details: firstNotFound
        ? { path: firstNotFound.path, code: firstNotFound.extensions?.code }
        : undefined
    }
  }
  if (s.includes('http 422') || s.includes('validation failed')) {
    return {
      type: 'validation_error',
      message: `Invalid request — ${stderr.trim()}`,
      reason: 'request_invalid',
      detail: stderr.trim()
    }
  }
  if (errors.length > 0) {
    const first = errors[0]
    return {
      type: 'unknown',
      message: first.message ?? 'Unknown GraphQL error.',
      details: { path: first.path, code: first.extensions?.code }
    }
  }
  // Bound unexpected diagnostics instead of exposing full request dumps.
  const firstLine =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  const safe = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
  return {
    type: 'unknown',
    message: safe ? `GitHub request failed: ${safe}` : 'GitHub request failed.',
    reason: 'request_failed',
    ...(safe ? { detail: safe } : {})
  }
}

export function driftError(
  reason: string,
  details?: { path?: (string | number)[]; code?: string }
): GitHubProjectViewError {
  return {
    type: 'schema_drift',
    message: `Could not read this project view: ${reason}.`,
    detail: reason,
    details
  }
}

// Shape pre-spawn breaker failures like classified rate limits; the guard already handles missing snapshots.
export function rateLimitedError(blocked: {
  remaining: number
  limit: number
  resetAt: number
}): GitHubProjectViewError {
  const resetIn = Math.max(0, blocked.resetAt - Math.floor(Date.now() / 1000))
  const mins = Math.ceil(resetIn / 60)
  return {
    type: 'rate_limited',
    message: `GitHub rate limit nearly exhausted (${blocked.remaining}/${blocked.limit} left). Resets in ~${mins}m.`,
    rateLimit: { remaining: blocked.remaining, limit: blocked.limit, resetMinutes: mins }
  }
}
