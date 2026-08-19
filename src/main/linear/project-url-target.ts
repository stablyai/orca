import { linearError, type LinearAgentAccessError } from './issue-context-errors'

export type LinearProjectUrlTarget = { workspaceKey: string; slug: string }

const LINEAR_HOST = 'linear.app'
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEMELESS_LINEAR = /^(?:www\.)?linear\.app\//i

/**
 * Returns null when the input is not URL-shaped so it can be treated as a slug
 * or name; throws when it looks like a URL but cannot be a project target.
 */
export function parseLinearProjectUrl(input: string): LinearProjectUrlTarget | null {
  if (!URL_SCHEME.test(input)) {
    if (SCHEMELESS_LINEAR.test(input)) {
      throw invalidProjectUrl(input, 'Linear project URLs must start with https://linear.app/.')
    }
    return null
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw invalidProjectUrl(input, 'The project URL could not be parsed.')
  }
  if (url.protocol !== 'https:' || url.host !== LINEAR_HOST) {
    throw invalidProjectUrl(input, `Project URLs must use https://${LINEAR_HOST}/.`)
  }

  // Why: split before decoding so only the project segment is decoded and an
  // encoded separator can never introduce new path structure.
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 3 || segments[1] !== 'project') {
    throw invalidProjectUrl(
      input,
      'Project URLs look like https://linear.app/<workspace>/project/<project-slug>.'
    )
  }

  let slug: string
  try {
    slug = decodeURIComponent(segments[2])
  } catch {
    throw invalidProjectUrl(input, 'The project segment has invalid percent-encoding.')
  }
  if (!slug || slug.includes('/') || slug.includes('\\')) {
    throw invalidProjectUrl(input, 'The project segment is empty or contains a path separator.')
  }
  // Trailing view segments such as /overview or /updates are ignored.
  return { workspaceKey: segments[0], slug }
}

function invalidProjectUrl(input: string, reason: string): LinearAgentAccessError {
  return linearError(
    'linear_invalid_project',
    `"${input}" is not a Linear project URL. ${reason}`,
    {
      nextSteps: ['Retry with a project id, slug, exact name, or a linear.app project URL.']
    }
  )
}
