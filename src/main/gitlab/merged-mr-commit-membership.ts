import { createHash } from 'node:crypto'
import {
  MergedReviewMembershipMemo,
  type MergedReviewCommitMembership
} from '../source-control/merged-review-membership-memo'
import { codeHostReadExecutionScope } from '../source-control/code-host-read-execution-scope'
import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'
import { consumeGitLabPages } from './gitlab-paginated-list'
import { readGlabViewer } from './gitlab-auth-and-rate-limit'
import {
  glabHostnameArgs,
  glabRepoExecOptions,
  type LocalGitExecOptions,
  type ProjectRef
} from './gl-utils'
import { encodedProject } from './project-path-encoding'

const membershipMemo = new MergedReviewMembershipMemo<ReadonlySet<string>>({
  weight: (ids) => 1024 + 256 * ids.size,
  maxWeight: 16 * 1024 * 1024,
  failureWeight: 1024,
  lru: true,
  ttl: () => 6 * 60 * 60_000
})
const viewers: CoalescedProbes<number | null> = new Map()
const digest = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const oid = (value: unknown): string | null =>
  typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : null

type MembershipTarget = {
  repoPath: string
  project: ProjectRef
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
}

function targetKey(args: MembershipTarget): string {
  return digest([
    'gitlab',
    args.project.host.trim().toLowerCase(),
    codeHostReadExecutionScope({
      ...glabRepoExecOptions(args.repoPath, args.connectionId, args.localGitOptions),
      connectionId: args.connectionId ?? null
    })
  ])
}

export function forgetMergedMRCommitMembership(
  args: MembershipTarget & { targetProjectId: number }
): void {
  const prefix = `${targetKey(args)}:${args.targetProjectId}:`
  membershipMemo.discardWhere((key) => key.startsWith(prefix))
}

export function resetMergedMRCommitMembershipForTest(): void {
  membershipMemo.clear()
  viewers.clear()
}

function revisionKey(headSha: unknown, diffRefs: unknown): (string | null)[] | null {
  const head = oid(headSha)
  if (!head) {
    return null
  }
  if (diffRefs === undefined || diffRefs === null) {
    return [head, null, null, null]
  }
  if (typeof diffRefs !== 'object' || Array.isArray(diffRefs)) {
    return null
  }
  const refs = [
    'head_sha' in diffRefs ? diffRefs.head_sha : undefined,
    'base_sha' in diffRefs ? diffRefs.base_sha : undefined,
    'start_sha' in diffRefs ? diffRefs.start_sha : undefined
  ]
  const parts = refs.map((value) => (value == null ? null : oid(value)))
  if (refs.some((value, i) => value != null && !parts[i])) {
    return null
  }
  if (parts[0] && parts[0] !== head) {
    return null
  }
  return [head, ...parts]
}

export async function mergedMRContainsHead(
  args: MembershipTarget & {
    targetProjectId: number
    iid: number
    headOid: string
    revisionHeadSha?: string
    diffRefs?: unknown
    userRefresh?: boolean
  }
): Promise<MergedReviewCommitMembership> {
  const options = glabRepoExecOptions(args.repoPath, args.connectionId, args.localGitOptions)
  const scope = codeHostReadExecutionScope({ ...options, connectionId: args.connectionId ?? null })
  const viewer = await runCoalescedProbe(
    viewers,
    digest([args.project.host.toLowerCase(), scope]),
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
  const load = async (): Promise<ReadonlySet<string>> => {
    const ids = new Set<string>()
    await consumeGitLabPages<{ id?: unknown }>(
      args.repoPath,
      args.project,
      `projects/${encodedProject(args.project.path)}/merge_requests/${args.iid}/commits`,
      args.connectionId,
      args.localGitOptions,
      (page) => {
        for (const commit of page) {
          const id = oid(commit?.id)
          if (!id) {
            throw new Error('Invalid GitLab merge request commits')
          }
          ids.add(id)
        }
      }
    )
    return ids
  }
  const revision = revisionKey(args.revisionHeadSha, args.diffRefs)
  // Uncertain bookkeeping never refuses the authorized complete read.
  const ids =
    viewer === null || revision === null
      ? await load()
      : await membershipMemo.read(
          `${targetKey(args)}:${args.targetProjectId}:${digest([viewer, args.iid, revision])}`,
          load,
          { refreshFailed: args.userRefresh }
        )
  return ids.has(args.headOid.toLowerCase()) ? 'contained' : 'not-contained'
}
