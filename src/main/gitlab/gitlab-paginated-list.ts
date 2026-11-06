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
// Bound pagination when a proxy strips or fails to advance next-page headers.
const MAX_PAGES = 50

// Older glab lacks NDJSON output and --jq; parse each API page separately.
export async function fetchAllGitLabPages<T>(
  repoPath: string,
  projectRef: ProjectRef,
  endpoint: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<T[]> {
  const items: T[] = []
  let page: number | undefined = 1
  for (let fetched = 0; page !== undefined && fetched < MAX_PAGES; fetched += 1) {
    const { body, headers } = await glabApiWithHeaders(
      [
        ...glabHostnameArgs(projectRef, connectionId),
        `${endpoint}?per_page=${PAGE_SIZE}&page=${page}`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    const pageItems = parseGlabJsonList<T>(body)
    items.push(...pageItems)
    page = nextPageNumber(headers['x-next-page'], page, pageItems.length)
  }
  return items
}

function nextPageNumber(
  nextPageHeader: string | undefined,
  page: number,
  pageLength: number
): number | undefined {
  // GitLab ends with an empty header; an absent header may be proxy-stripped, so probe after full pages.
  if (nextPageHeader === undefined) {
    return pageLength < PAGE_SIZE ? undefined : page + 1
  }
  return parseGlabPaginationHeader(nextPageHeader, page + 1)
}
