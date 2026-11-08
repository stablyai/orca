import * as z from 'zod'
import { translate } from '../i18n/mobile-i18n'
import { defineHostQuery } from '../query/host-query'
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

// No desktop signal for working-tree edits yet, so focus and foreground revalidate once older than 3 s.
export const gitStatusQuery = defineHostQuery({
  family: 'git.status',
  staleTime: 3_000,
  refetchOnWindowFocus: true,
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
