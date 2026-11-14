import * as z from 'zod'
import { hashKey, type QueryClient } from '@tanstack/react-query'
import { translate } from '../../i18n/mobile-i18n'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../src/shared/execution-host'
import { getRepoIdFromWorktreeId, worktreeIdsEqual } from '../../../../src/shared/worktree/id'
import { defineHostQuery, type HostSignalEvent } from '../../query/host-query'
import { hostQueryKey, type HostQueryTarget } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  gitStatusHostPayloadSchema,
  type MobileGitStatusHostPayload
} from '../git/git-status-reply-schema'
import { gitStatusHostPayloadRead } from '../git/mobile-git-read-operations'
import { holdsRestoredHostQueryData } from '../../query/host-query-persistence'
import {
  isMobileGitTransientRefreshError,
  isMobileGitUnavailableReply,
  readMobileGitRefusal
} from './mobile-git-status'
import {
  SELECTOR_RETRY_COUNT,
  SELECTOR_RETRY_DELAY_MS,
  wait
} from './mobile-source-control-screen-state'

export type GitStatusRead =
  | { kind: 'ready'; status: MobileGitStatusHostPayload }
  | { kind: 'unavailable' }

async function readGitStatus(
  client: RpcClient,
  worktreeId: string,
  revalidating: boolean,
  lineStats = true
): Promise<GitStatusRead> {
  for (let attempt = 0; ; attempt += 1) {
    // Changes rows show each file's +/- counts, so ask the host for line stats.
    const reply = await gitStatusHostPayloadRead.request(client, {
      worktree: `id:${worktreeId}`,
      ...(lineStats ? {} : { includeLineStats: false }),
      // Rows are already shown: reuse counts while HEAD and entries match, and never wake a stopped WSL distro.
      ...(revalidating && { reuseLineStats: true, admissionTier: 'background' as const })
    })
    // Inspect refusal code before acceptance policy loses capability/retry routing information.
    const refusal = readMobileGitRefusal(reply)
    if (!refusal) {
      return { kind: 'ready', status: gitStatusHostPayloadRead.interpret(reply) }
    }
    if (isMobileGitUnavailableReply(reply)) {
      return { kind: 'unavailable' }
    }
    const shouldRetry =
      refusal.code === 'selector_not_found' ||
      isMobileGitTransientRefreshError(refusal.code, refusal.message)
    if (!shouldRetry || attempt >= SELECTOR_RETRY_COUNT) {
      throw new Error(
        refusal.message ||
          translate('sourceControl.loaders.loadFailed', 'Unable to load source control')
      )
    }
    await wait(SELECTOR_RETRY_DELAY_MS)
  }
}

// The desktop's own repos only: its watcher never sees a relayed server's.
function namesThisStatus(event: HostSignalEvent, target: HostQueryTarget): boolean {
  if (event.type !== 'gitStatusChanged' || target.exec !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  const worktreeId = target.worktree ?? ''
  if (getRepoIdFromWorktreeId(worktreeId) !== event.repoId) {
    return false
  }
  return event.worktreeIds?.some((id) => worktreeIdsEqual(id, worktreeId)) ?? true
}

// Commits, staging and checkouts signal; working-tree edits, SSH and serve don't, so focus and foreground still revalidate once older than 3 s.
export const gitStatusQuery = defineHostQuery({
  family: 'git.status',
  staleTime: 3_000,
  refetchOnWindowFocus: true,
  // A rebase or an agent's commits can signal several times a second.
  signal: { events: ['gitStatusChanged'], floorMs: 1_000, matches: namesThisStatus },
  // Rows from an earlier launch are shown but unconfirmed, so that first read runs at full priority.
  fetch: (
    client,
    target,
    _input: Record<string, never>,
    previous: GitStatusRead | undefined,
    { previousFromStore }
  ) => readGitStatus(client, target.worktree ?? '', previous !== undefined && !previousFromStore),
  persist: {
    version: 1,
    dataSchema: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ready'), status: gitStatusHostPayloadSchema }),
      z.object({ kind: z.literal('unavailable') })
    ])
  }
})

const fetchStatusSummary = (
  client: RpcClient,
  target: HostQueryTarget,
  _input: Record<string, never>,
  previous: GitStatusRead | undefined
) => readGitStatus(client, target.worktree ?? '', previous !== undefined, false)

/** Branch, sync and change count only, for a list that shows no per-file counts; older hosts ignore the opt-out. */
export const gitStatusSummaryQuery = defineHostQuery({
  family: 'git.statusSummary',
  staleTime: 3_000,
  refetchOnWindowFocus: true,
  signal: { events: ['gitStatusChanged'], floorMs: 1_000, matches: namesThisStatus },
  fetch: fetchStatusSummary
})

// A relayed server's statuses get no desktop signal (namesThisStatus), so its reads hold no event stream.
export const serverGitStatusSummaryQuery = defineHostQuery({
  family: 'git.statusSummary.server',
  staleTime: 3_000,
  refetchOnWindowFocus: true,
  fetch: fetchStatusSummary
})

/** Hands a detailed read to the summary a folder list shows for the same worktree, so Back shows what an action just did. */
export async function publishGitStatusSummary(
  queryClient: QueryClient,
  hostId: string,
  target: HostQueryTarget,
  read: GitStatusRead,
  readAt: number,
  /** A read accepted now; otherwise a cached one, which can't tell whether a summary read out started before it. */
  accepted: boolean
): Promise<void> {
  // An earlier launch's copy is unconfirmed; the summary's own read decides.
  if (
    holdsRestoredHostQueryData(
      queryClient,
      hashKey(hostQueryKey(hostId, gitStatusQuery.family, target, {}))
    )
  ) {
    return
  }
  const summary =
    target.exec === LOCAL_EXECUTION_HOST_ID ? gitStatusSummaryQuery : serverGitStatusSummaryQuery
  const queryKey = hostQueryKey(hostId, summary.family, target, {})
  // No list reads this worktree, or its summary, a failed read included, is newer than this read.
  const supersedes = () => {
    const state = queryClient.getQueryState(queryKey)
    return state !== undefined && Math.max(state.dataUpdatedAt, state.errorUpdatedAt) < readAt
  }
  if (!supersedes()) {
    return
  }
  if (queryClient.getQueryState(queryKey)?.fetchStatus !== 'idle') {
    // A cached read leaves a summary read out to answer for itself.
    if (!accepted) {
      return
    }
    // A summary read out started before this answer; landing later, it would undo it.
    await queryClient.cancelQueries({ queryKey, exact: true }, { silent: true })
  }
  if (supersedes()) {
    queryClient.setQueryData(queryKey, read, { updatedAt: readAt })
  }
}
