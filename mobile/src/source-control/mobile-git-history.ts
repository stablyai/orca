import { translate } from '../i18n/mobile-i18n'
import type { MobileGitHistoryResult } from './git-history-reply-schema'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { gitHistoryRead } from './mobile-git-read-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'
import { GIT_HISTORY_DEFAULT_LIMIT } from '../../../src/shared/git-history-types'

// Desktop's request: one page of HEAD history, with the compare base so the host reports it.
export async function fetchMobileGitHistory(
  client: RpcOperationSender,
  worktreeId: string,
  baseRef: string | null
): Promise<MobileGitHistoryResult> {
  // Transport rejection must escape as its original error object.
  const reply = await gitHistoryRead.request(client, {
    worktree: `id:${worktreeId}`,
    limit: GIT_HISTORY_DEFAULT_LIMIT,
    baseRef
  })
  try {
    return gitHistoryRead.interpret(reply)
  } catch (error) {
    throw new Error(
      refusedRpcMessageOrFallback(
        error,
        translate('sourceControl.gitHistory.loadFailed', 'Failed to load commit history')
      )
    )
  }
}
