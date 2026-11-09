import {
  MergedReviewMembershipMemo,
  type MergedReviewCommitMembership
} from '../source-control/merged-review-membership-memo'
import { codeHostReadExecutionScope } from '../source-control/code-host-read-execution-scope'
import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'
import { fetchAllGitLabPages } from './gitlab-paginated-list'
import { readGlabViewer } from './gitlab-auth-and-rate-limit'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

const membershipMemo = new MergedReviewMembershipMemo()
const viewers: CoalescedProbes<number | null> = new Map()

export function resetMergedMRCommitMembershipForTest(): void {
  membershipMemo.clear()
  viewers.clear()
}

export async function mergedMRContainsHead(args: {
  repoPath: string
  project: ProjectRef
  targetProjectId: number
  iid: number
  headOid: string
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
  userRefresh?: boolean
}): Promise<MergedReviewCommitMembership> {
  const options = glabRepoExecOptions(args.repoPath, args.connectionId, args.localGitOptions)
  const scope = codeHostReadExecutionScope({ ...options, connectionId: args.connectionId ?? null })
  const viewerKey = `${args.project.host.toLowerCase()}\0${scope}`
  const viewer = await runCoalescedProbe(
    viewers,
    viewerKey,
    async () => {
      try {
        const data = await readGlabViewer(
          glabHostnameArgs(args.project, args.connectionId),
          options
        )
        return typeof data.id === 'number' && Number.isSafeInteger(data.id) && data.id > 0
          ? data.id
          : null
      } catch {
        return null
      }
    },
    Infinity,
    { userRefresh: args.userRefresh }
  )
  const load = async (): Promise<MergedReviewCommitMembership> => {
    const commits = await fetchAllGitLabPages<{ id?: unknown }>(
      args.repoPath,
      args.project,
      `projects/${encodedProject(args.project.path)}/merge_requests/${args.iid}/commits`,
      args.connectionId,
      args.localGitOptions
    )
    if (
      commits.some(
        (commit) => typeof commit.id !== 'string' || !/^[0-9a-f]{40,64}$/i.test(commit.id)
      )
    ) {
      throw new Error('Invalid GitLab merge request commits')
    }
    return commits.some(
      (commit) =>
        typeof commit.id === 'string' && commit.id.toLowerCase() === args.headOid.toLowerCase()
    )
      ? 'contained'
      : 'not-contained'
  }
  // A missing account identity disables bookkeeping, never the authorized fresh read.
  if (viewer === null) {
    return load()
  }
  const key = [
    'gitlab',
    args.project.host.toLowerCase(),
    scope,
    viewer,
    args.targetProjectId,
    args.iid,
    args.headOid.toLowerCase()
  ].join('\0')
  return membershipMemo.read(key, load, { refreshFailed: args.userRefresh })
}
