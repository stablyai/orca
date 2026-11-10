import {
  glabApiWithHeaders,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGlabJsonList,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// GitLab caps per_page at 100.
const PAGE_SIZE = 100
// Bound guessed pages when a proxy strips, garbles or stalls next-page headers.
const MAX_PROBED_PAGES = 50

/** A page after the first failed, so the rows read so far are not the whole list. */
export class GitLabIncompletePaginationError extends Error {}

// Older glab lacks NDJSON output and --jq; parse each API page separately.
export async function fetchAllGitLabPages<T>(
  repoPath: string,
  projectRef: ProjectRef,
  endpoint: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  signal?: AbortSignal
): Promise<T[]> {
  const items: T[] = []
  await consumeGitLabPages<T>(
    repoPath,
    projectRef,
    endpoint,
    connectionId,
    localGitOptions,
    (page) => {
      items.push(...page)
    },
    signal
  )
  return items
}

/** Consume and release each raw page before requesting the next one. */
export async function consumeGitLabPages<T>(
  repoPath: string,
  projectRef: ProjectRef,
  endpoint: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  consume: (page: T[]) => void,
  signal?: AbortSignal
): Promise<void> {
  let probedPages = 0
  let page: number | undefined = 1
  while (page !== undefined) {
    signal?.throwIfAborted()
    let pageItems: T[]
    let nextPageHeader: string | undefined
    try {
      const { body, headers } = await glabApiWithHeaders(
        [
          ...glabHostnameArgs(projectRef, connectionId),
          `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      pageItems = parseGlabJsonList<T>(body)
      nextPageHeader = headers['x-next-page']
    } catch (error) {
      // A prefix must not pass for the full list; callers keep what they last showed.
      if (page > 1) {
        throw new GitLabIncompletePaginationError(`GitLab list incomplete after page ${page - 1}`, {
          cause: error
        })
      }
      throw error
    }
    consume(pageItems)
    // Follow only a header naming the next page after a non-empty one; a skip would hide rows.
    if (pageItems.length > 0 && nextPageHeader?.trim() === String(page + 1)) {
      page += 1
    } else if (
      // GitLab ends with an empty header; otherwise probe after full pages.
      nextPageHeader === '' ||
      pageItems.length < PAGE_SIZE
    ) {
      page = undefined
    } else if (probedPages >= MAX_PROBED_PAGES) {
      throw new GitLabIncompletePaginationError(
        `GitLab list still full after ${page} guessed pages`
      )
    } else {
      probedPages += 1
      page += 1
    }
  }
}
