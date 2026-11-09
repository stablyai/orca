import * as z from 'zod'
import { translate } from '../i18n/mobile-i18n'
import { LOCAL_EXECUTION_HOST_ID } from '../../../src/shared/execution-host'
import { getRepoIdFromWorktreeId, worktreeIdsEqual } from '../../../src/shared/worktree/id'
import { defineHostQuery, type HostSignalEvent } from '../query/host-query'
import type { HostQueryTarget } from '../query/host-query-key'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import {
  gitStatusHostPayloadSchema,
  type MobileGitStatusHostPayload
} from './git-status-reply-schema'
import { gitStatusHostPayloadRead } from './mobile-git-read-operations'
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
  revalidating: boolean
): Promise<GitStatusRead> {
  for (let attempt = 0; ; attempt += 1) {
    // Changes rows show each file's +/- counts, so ask the host for line stats.
    const reply = await gitStatusHostPayloadRead.request(client, {
      worktree: `id:${worktreeId}`,
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
