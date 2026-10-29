import { translate } from '../i18n/mobile-i18n'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import {
  gitCancelGenerateCommitMessageRun,
  gitGenerateCommitMessageRun,
  type MobileGenerateCommitMessageResult
} from './mobile-git-mutation-operations'
import type { RpcOperationSender } from '../transport/rpc-operation-sender'

export type { MobileGenerateCommitMessageResult }

// Collapse refusals and malformed payloads to the same failed-generation verdict.
export async function requestMobileCommitMessage(
  client: RpcOperationSender,
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
      error: refusedRpcMessageOrFallback(
        error,
        translate(
          'sourceControl.commitMessageAi.generateFailed',
          'Failed to generate commit message'
        )
      )
    }
  }
}

export async function cancelMobileCommitMessage(
  client: RpcOperationSender,
  worktreeId: string
): Promise<void> {
  const reply = await gitCancelGenerateCommitMessageRun.request(client, {
    worktree: `id:${worktreeId}`
  })
  gitCancelGenerateCommitMessageRun.interpret(reply)
}
