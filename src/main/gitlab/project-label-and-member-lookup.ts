import type { GitLabAssignableUser } from '../../shared/gitlab-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { mapGitLabUser, type GitLabRawUser } from './gitlab-assignable-user-mapping'
import {
  acquire,
  getGlabKnownHosts,
  glabApiWithHeaders,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGlabJsonList,
  parseGlabPaginationHeader,
  release,
  resolveIssueSource,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

// GitLab's per_page maximum.
const PAGE_SIZE = 100
// Why: bounds the walk (5,000 entries) when a proxy strips x-next-page or it never advances.
const MAX_PAGES = 50

type GitLabRawLabel = { name?: string | null } | null

export async function listLabels(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string[]> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    const labels = await fetchAllPages<GitLabRawLabel>(
      repoPath,
      projectRef,
      `projects/${encodedProject(projectRef.path)}/labels`,
      connectionId,
      localGitOptions
    )
    return labels.flatMap((label) => (label?.name ? [label.name] : []))
  } catch {
    return []
  } finally {
    release()
  }
}

export async function listAssignableUsers(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabAssignableUser[]> {
  const knownHosts = await getGlabKnownHosts(connectionId, localGitOptions)
  const { source: projectRef } = await resolveIssueSource(
    repoPath,
    preference,
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (!projectRef) {
    return []
  }
  await acquire()
  try {
    // Why: `members/all` returns project members including those inherited
    // from parent groups — important for projects under a top-level group
    // where assignable users typically come from the group, not the project.
    const members = await fetchAllPages<GitLabRawUser | null>(
      repoPath,
      projectRef,
      `projects/${encodedProject(projectRef.path)}/members/all`,
      connectionId,
      localGitOptions
    )
    return members.map(mapGitLabUser).filter((user): user is GitLabAssignableUser => user !== null)
  } catch {
    return []
  } finally {
    release()
  }
}

// Why: `glab api` has no --jq and older glab lacks `--output ndjson`, so walk the pages here
// and parse each one as a JSON list.
async function fetchAllPages<T>(
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
  // Why: GitLab sends an empty x-next-page on the last page, so an absent one means a proxy
  // stripped it; a full page then probes one more.
  if (nextPageHeader === undefined) {
    return pageLength < PAGE_SIZE ? undefined : page + 1
  }
  return parseGlabPaginationHeader(nextPageHeader, page + 1)
}
