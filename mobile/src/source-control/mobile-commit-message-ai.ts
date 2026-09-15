import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import {
  gitCancelGenerateCommitMessageRun,
  gitGenerateCommitMessageRun,
  type MobileGenerateCommitMessageResult
} from './mobile-git-mutation-operations'
import type { MobileSourceControlRpcSender } from './mobile-source-control-rpc-sender'

export type { MobileGenerateCommitMessageResult }

// A refusal or a malformed payload collapses to { success:false } so the caller never has to
// special-case either; the operation's reader owns the payload half of that.
export async function requestMobileCommitMessage(
  client: MobileSourceControlRpcSender,
  worktreeId: string
): Promise<MobileGenerateCommitMessageResult> {
  const reply = await gitGenerateCommitMessageRun.request(client, {
    worktree: `id:${worktreeId}`
  })

  try {
    return gitGenerateCommitMessageRun.interpret(reply)
  } catch (error) {
    return {
      success: false,
      error: refusedRpcMessageOrFallback(error, 'Failed to generate commit message')
    }
  }
}

export async function cancelMobileCommitMessage(
  client: MobileSourceControlRpcSender,
  worktreeId: string
): Promise<void> {
  const reply = await gitCancelGenerateCommitMessageRun.request(client, {
    worktree: `id:${worktreeId}`
  })

  gitCancelGenerateCommitMessageRun.interpret(reply)
}
