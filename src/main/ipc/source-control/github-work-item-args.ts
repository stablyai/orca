import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'
import type { IssueSourcePreference, Repo } from '../../../shared/repository/repo-types'
import { getRepoRoutingConnectionId } from '../../../shared/execution-host/execution-host'

export type WorkItemArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type LocalGitExecOptions = {
  wslDistro?: string
}

// Reject invalid item numbers; unknown types fall back to issue-then-PR probing.
export function dispatchWorkItem<T>(
  args: WorkItemArgs,
  repo: Pick<Repo, 'path' | 'executionHostId' | 'connectionId' | 'issueSourcePreference'>,
  fn: (
    path: string,
    n: number,
    t?: 'issue' | 'pr',
    connectionId?: string | null,
    localGitOptions?: LocalGitExecOptions,
    preference?: IssueSourcePreference
  ) => Promise<T | null>,
  localGitOptions?: LocalGitExecOptions
): Promise<T | null> | null {
  const { number, type } = args
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) {
    return null
  }
  const safeType = type === 'issue' || type === 'pr' ? type : undefined
  // Open-by-number must use the same origin/upstream source as listing and launch.
  return fn(
    repo.path,
    number,
    safeType,
    getRepoRoutingConnectionId(repo),
    localGitOptions,
    repo.issueSourcePreference
  )
}
