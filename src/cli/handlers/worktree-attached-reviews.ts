import { parseGitHubIssueOrPRLink } from '../../shared/github-links'
import { addAttachedReview } from '../../shared/attached-reviews'
import { RuntimeClientError } from '../runtime-client'
import type { AttachedReview } from '../../shared/types'

/**
 * Builds the attached-review list from `--add-pr` / `--clear-prs`.
 *
 * These sit alongside the branch's own auto-detected review rather than
 * replacing it: a workspace whose branch ships to several destinations has one
 * review Orca finds on its own and N the user knows about.
 *
 * `--add-pr` takes a comma-separated list rather than repeating, because the
 * arg parser stores flags in a Map and a repeated flag would silently keep only
 * the last value. Calls are additive, so attaching one at a time across several
 * invocations works too.
 *
 * A JSON array is accepted in place of the URL list when the caller knows more
 * than the URL carries. Base ref and title cannot be derived from a PR link,
 * and they are what tells two reviews off the same branch apart — without them
 * a stack of reviews renders as a list of bare numbers.
 */
export function getAttachedReviewsUpdate(
  flags: Map<string, string | boolean>,
  current: readonly AttachedReview[] | undefined
): { attachedReviews?: AttachedReview[] } {
  const clear = flags.get('clear-prs') === true
  const raw = flags.get('add-pr')

  if (raw !== undefined && typeof raw !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --add-pr')
  }
  const incoming = parseAddPrValue(raw ?? '')

  if (incoming.length === 0) {
    return clear ? { attachedReviews: [] } : {}
  }

  // Why: --clear-prs with --add-pr means "replace", which is the only way to
  // drop a stale review without a separate remove flag.
  let next: AttachedReview[] = clear ? [] : [...(current ?? [])]
  for (const review of incoming) {
    next = addAttachedReview(next, review)
  }
  return { attachedReviews: next }
}

function parseAddPrValue(raw: string): AttachedReview[] {
  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    return parseReviewJson(trimmed)
  }
  return trimmed
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .map(parseReviewUrl)
}

function parseReviewJson(value: string): AttachedReview[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new RuntimeClientError('invalid_argument', 'Could not parse --add-pr as JSON')
  }
  if (!Array.isArray(parsed)) {
    throw new RuntimeClientError('invalid_argument', '--add-pr JSON must be an array of reviews')
  }

  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new RuntimeClientError('invalid_argument', 'Each --add-pr entry must be an object')
    }
    const item = entry as Record<string, unknown>
    if (typeof item.url !== 'string') {
      throw new RuntimeClientError('invalid_argument', 'Each --add-pr entry needs a url')
    }
    // The URL still decides provider and number, so a JSON entry cannot claim
    // to be a review the link itself does not describe.
    const review = parseReviewUrl(item.url)
    if (typeof item.baseRef === 'string' && item.baseRef.trim().length > 0) {
      review.baseRef = item.baseRef.trim()
    }
    if (typeof item.title === 'string' && item.title.trim().length > 0) {
      review.title = item.title.trim()
    }
    if (typeof item.state === 'string') {
      const state = item.state.toLowerCase()
      if (state === 'open' || state === 'merged' || state === 'closed' || state === 'draft') {
        review.state = state
      }
    }
    return review
  })
}

function parseReviewUrl(value: string): AttachedReview {
  const trimmed = value.trim()
  const gh = parseGitHubIssueOrPRLink(trimmed)
  if (gh) {
    return { provider: 'github', number: gh.number, url: trimmed }
  }

  // Other providers are matched by URL shape rather than parsed in depth: the
  // number and host are all that is needed to render and open the row, and
  // hard-coding each provider's path layout would rot as they change.
  const generic = parseGenericReviewUrl(trimmed)
  if (generic) {
    return generic
  }

  throw new RuntimeClientError(
    'invalid_argument',
    `Not a recognizable pull/merge request URL: ${value}`
  )
}

const HOST_PROVIDERS: readonly [RegExp, AttachedReview['provider']][] = [
  [/(^|\.)gitlab\./i, 'gitlab'],
  [/(^|\.)bitbucket\./i, 'bitbucket'],
  [/(^|\.)dev\.azure\.com$|visualstudio\.com$/i, 'azure-devops'],
  [/(^|\.)gitea\./i, 'gitea']
]

const NUMBER_PATH = /\/(?:pull|pulls|merge_requests|pullrequest|pullrequests)\/(\d+)(?:\/|$)/i

function parseGenericReviewUrl(value: string): AttachedReview | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  const match = url.pathname.match(NUMBER_PATH)
  if (!match) {
    return null
  }
  const number = Number(match[1])
  if (!Number.isInteger(number) || number <= 0) {
    return null
  }
  const provider = HOST_PROVIDERS.find(([pattern]) => pattern.test(url.hostname))?.[1]
  if (!provider) {
    return null
  }
  return { provider, number, url: value.trim() }
}
