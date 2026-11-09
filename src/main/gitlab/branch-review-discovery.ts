import { selectBranchReview } from '../source-control/branch-review-selection'
import { extractExecError } from '../git/exec-error'
import { fetchAllGitLabPages } from './gitlab-paginated-list'
import { isUnsupportedReviewListFilter } from './glab-error-classification'
import {
  glabExecFileAsync,
  glabHostnameArgs,
  glabRepoExecOptions,
  parseGlabJsonList,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

export type GitLabBranchReview = {
  iid: number
  state: string
  source_project_id: number
  target_project_id: number
  source_branch: string
  updated_at: string
}

class GitLabReviewFilterUnavailableError extends Error {}

function validateReviews(rows: unknown[], branch: string): GitLabBranchReview[] {
  if (
    !rows.every((row): row is GitLabBranchReview => {
      if (!row || typeof row !== 'object') {
        return false
      }
      const data = row as Record<string, unknown>
      return (
        typeof data.iid === 'number' &&
        Number.isSafeInteger(data.iid) &&
        data.iid > 0 &&
        typeof data.source_project_id === 'number' &&
        Number.isSafeInteger(data.source_project_id) &&
        data.source_project_id > 0 &&
        typeof data.target_project_id === 'number' &&
        Number.isSafeInteger(data.target_project_id) &&
        data.target_project_id > 0 &&
        typeof data.state === 'string' &&
        ['opened', 'locked', 'closed', 'merged'].includes(data.state) &&
        data.source_branch === branch &&
        typeof data.updated_at === 'string' &&
        Number.isFinite(Date.parse(data.updated_at))
      )
    })
  ) {
    throw new Error('Invalid GitLab branch review list')
  }
  return rows
}

export function isActiveGitLabReview(review: GitLabBranchReview): boolean {
  return review.state === 'opened' || review.state === 'locked'
}

/** Compatibility observation lasts for this lookup, including its one qualified alternate name. */
export function createGitLabBranchDiscovery(args: {
  repoPath: string
  project: ProjectRef
  sourceProjectId: number
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
}): (branch: string) => Promise<GitLabBranchReview | null> {
  let completeTraversal = false
  const endpoint = `projects/${encodedProject(args.project.path)}/merge_requests`
  const ordered = (branch: string) =>
    `source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc&with_merge_status_recheck=true`
  const readComplete = async (branch: string): Promise<GitLabBranchReview | null> => {
    const raw = await fetchAllGitLabPages<unknown>(
      args.repoPath,
      args.project,
      `${endpoint}?${ordered(branch)}&state=all`,
      args.connectionId,
      args.localGitOptions
    )
    const rows = validateReviews(raw, branch).filter(
      (row) => row.source_project_id === args.sourceProjectId
    )
    return rows.find(isActiveGitLabReview) ?? rows[0] ?? null
  }
  const read = async (
    branch: string,
    state: 'all' | 'opened' | 'locked',
    limit: number
  ): Promise<GitLabBranchReview[]> => {
    let stdout: string
    try {
      ;({ stdout } = await glabExecFileAsync(
        [
          'api',
          ...glabHostnameArgs(args.project, args.connectionId),
          `${endpoint}?${ordered(branch)}&source_project_id=${args.sourceProjectId}&state=${state}&per_page=${limit}`
        ],
        glabRepoExecOptions(args.repoPath, args.connectionId, args.localGitOptions)
      ))
    } catch (error) {
      const detail = extractExecError(error)
      if (isUnsupportedReviewListFilter([detail.stderr, detail.stdout].join('\n'), state)) {
        throw new GitLabReviewFilterUnavailableError()
      }
      throw error
    }
    const rows = validateReviews(parseGlabJsonList<unknown>(stdout), branch)
    if (rows.some((row) => row.source_project_id !== args.sourceProjectId)) {
      throw new GitLabReviewFilterUnavailableError()
    }
    if (state !== 'all' && rows.some((row) => row.state !== state)) {
      throw new Error('Invalid GitLab active review list')
    }
    return rows
  }
  return async (branch) => {
    if (completeTraversal) {
      return readComplete(branch)
    }
    try {
      return await selectBranchReview({
        readRecent: () => read(branch, 'all', 10),
        readActive: async () => {
          const opened = (await read(branch, 'opened', 1))[0]
          const locked = (await read(branch, 'locked', 1))[0]
          return (
            [opened, locked]
              .filter((row) => row !== undefined)
              .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ?? null
          )
        },
        isActive: isActiveGitLabReview,
        pageSize: 10
      })
    } catch (error) {
      if (!(error instanceof GitLabReviewFilterUnavailableError)) {
        throw error
      }
      completeTraversal = true
      return readComplete(branch)
    }
  }
}
