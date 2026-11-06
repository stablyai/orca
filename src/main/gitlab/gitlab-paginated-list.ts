import {
  glabApiWithHeaders,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGlabJsonList,
  parseGlabPaginationHeader,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

// GitLab caps per_page at 100.
const PAGE_SIZE = 100
// Bound guessed pages when a proxy strips, garbles or stalls next-page headers.
const MAX_PROBED_PAGES = 50

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
          `${endpoint}?per_page=${PAGE_SIZE}&page=${page}`
        ],
        glabRepoExecOptions(repoPath, connectionId, localGitOptions)
      )
      pageItems = parseGlabJsonList<T>(body)
      nextPageHeader = headers['x-next-page']
    } catch (error) {
      // A failed later page must not blank the rows a single-page fetch used to show.
      if (page > 1) {
        return items
      }
      throw error
    }
    items.push(...pageItems)
    // Header page numbers must advance, so following them always terminates.
    const advertised = parseGlabPaginationHeader(nextPageHeader, page + 1)
    if (advertised !== undefined) {
      page = advertised
    } else if (
      // GitLab ends with an empty header; otherwise probe after full pages.
      nextPageHeader === '' ||
      pageItems.length < PAGE_SIZE ||
      probedPages >= MAX_PROBED_PAGES
    ) {
      page = undefined
    } else {
      probedPages += 1
      page += 1
    }
  }
  return items
}
