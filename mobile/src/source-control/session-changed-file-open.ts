import type { RpcClient } from '../transport/rpc-client'
import { isRendererUnavailableRefusal } from '../transport/renderer-unavailable-refusal'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import { sourceFileDiffOpenRun, sourceFileOpenRun } from './mobile-source-file-open-operations'

export type SessionDiffOpenChoice = 'diff-tab' | 'edit-tab' | 'device-review'

// Preserve the refusal code so headless hosts can use the device's review screen.
export function chooseSessionDiffOpen(reply: RpcResponse): SessionDiffOpenChoice {
  if (isRendererUnavailableRefusal(reply)) {
    return 'device-review'
  }
  // A host too old to open a diff tab still opens the file in an edit tab.
  return isMobileGitUnavailableReply(reply) ? 'edit-tab' : 'diff-tab'
}

export async function openSessionChangedFile(
  client: RpcClient,
  args: { worktreeId: string; relativePath: string; staged: boolean }
): Promise<'diff' | 'edit' | 'device-review'> {
  const worktree = `id:${args.worktreeId}`
  const diffReply = await sourceFileDiffOpenRun.request(client, {
    worktree,
    relativePath: args.relativePath,
    staged: args.staged
  })
  const diffChoice = chooseSessionDiffOpen(diffReply)
  if (diffChoice === 'device-review') {
    return 'device-review'
  }
  if (diffChoice === 'diff-tab') {
    interpretOrThrowRefusalMessage(
      () => sourceFileDiffOpenRun.interpret(diffReply),
      'Unable to open diff'
    )
    return 'diff'
  }
  const editReply = await sourceFileOpenRun.request(client, {
    worktree,
    relativePath: args.relativePath
  })
  if (isRendererUnavailableRefusal(editReply)) {
    return 'device-review'
  }
  interpretOrThrowRefusalMessage(
    () => sourceFileOpenRun.interpret(editReply),
    'Unable to open diff'
  )
  return 'edit'
}
