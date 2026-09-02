import type { GitLabAssignableUser, GitLabMRApprovalState } from '../../shared/gitlab-types'
import { mapGitLabUser, type GitLabRawUser } from './gitlab-assignable-user-mapping'
import { encodedProject } from './project-path-encoding'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  glabExecFileAsync,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'

export async function fetchMRReviewers(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabAssignableUser[]> {
  const { stdout } = await glabExecFileAsync(
    [
      'api',
      ...glabHostnameArgs(projectRef, connectionId),
      `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/reviewers`
    ],
    glabRepoExecOptions(repoPath, connectionId, localGitOptions)
  )
  const data = JSON.parse(stdout) as { user?: GitLabRawUser | null }[]
  return data
    .map((entry) => mapGitLabUser(entry.user))
    .filter((u): u is GitLabAssignableUser => !!u)
}

export async function fetchMRApprovalState(
  repoPath: string,
  projectRef: ProjectRef,
  iid: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitLabMRApprovalState | undefined> {
  const [approvalsRes, stateRes] = await Promise.allSettled([
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/approvals`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    ),
    glabExecFileAsync(
      [
        'api',
        ...glabHostnameArgs(projectRef, connectionId),
        `projects/${encodedProject(projectRef.path)}/merge_requests/${iid}/approval_state`
      ],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
  ])
  if (approvalsRes.status === 'rejected' && stateRes.status === 'rejected') {
    return undefined
  }
  const approvals =
    approvalsRes.status === 'fulfilled'
      ? (JSON.parse(approvalsRes.value.stdout) as {
          approvals_required?: number | null
          approvals_left?: number | null
          approved_by?: { user?: GitLabRawUser | null }[]
        })
      : null
  const state =
    stateRes.status === 'fulfilled'
      ? (JSON.parse(stateRes.value.stdout) as {
          rules?: {
            id?: number
            name?: string
            approvals_required?: number
            approved?: boolean
          }[]
        })
      : null
  return {
    approvalsRequired:
      typeof approvals?.approvals_required === 'number' ? approvals.approvals_required : null,
    approvalsLeft: typeof approvals?.approvals_left === 'number' ? approvals.approvals_left : null,
    approvedBy: (approvals?.approved_by ?? [])
      .map((entry) => mapGitLabUser(entry.user))
      .filter((u): u is GitLabAssignableUser => !!u),
    rules: (state?.rules ?? []).map((rule) => ({
      id: rule.id ?? 0,
      name: rule.name ?? 'Approval rule',
      approvalsRequired: rule.approvals_required ?? 0,
      approved: Boolean(rule.approved)
    }))
  }
}
