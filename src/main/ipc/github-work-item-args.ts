import type { TaskSourceContext } from '../../shared/task-source-context'
import type { IssueSourcePreference } from '../../shared/types'

export type WorkItemArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type RegisteredRepoContext = {
  path: string
  connectionId?: string | null
  issueSourcePreference?: IssueSourcePreference
}

type LocalGitExecOptions = {
  wslDistro?: string
}

// Why: renderer input crosses the IPC boundary and is untrusted. Reject
// non-integer or < 1 numbers, and coerce unrecognised `type` values to
// undefined so getWorkItem falls through to its issue-then-PR probe rather
// than silently dispatching to the wrong branch.
export function dispatchWorkItem<T>(
  args: WorkItemArgs,
  repo: RegisteredRepoContext,
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
  // Why: open-by-number must pin the same source the list and start-point use,
  // else a fork and its upstream sharing a PR number resolve to different PRs.
  return fn(
    repo.path,
    number,
    safeType,
    repo.connectionId ?? null,
    localGitOptions,
    repo.issueSourcePreference
  )
}
