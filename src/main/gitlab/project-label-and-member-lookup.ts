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

const PAGE_SIZE = 100
// Bound pagination when a proxy strips or fails to advance next-page headers.
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
    // Include members inherited from parent groups, where assignable project users commonly originate.
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

// Older glab lacks NDJSON output and --jq; parse each API page separately.
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
  // GitLab ends with an empty header; an absent header may be proxy-stripped, so probe after full pages.
  if (nextPageHeader === undefined) {
    return pageLength < PAGE_SIZE ? undefined : page + 1
  }
  return parseGlabPaginationHeader(nextPageHeader, page + 1)
}
