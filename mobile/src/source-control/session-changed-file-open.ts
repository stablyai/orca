import type { RpcClient } from '../transport/rpc-client'
import { isRendererUnavailableRefusal } from '../transport/renderer-unavailable-refusal'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import type { RpcResponse } from '../transport/types'
import { isMobileGitUnavailableReply } from './mobile-git-status'
import { sourceFileDiffOpenRun, sourceFileOpenRun } from './mobile-source-file-open-operations'

export type SessionDiffOpenChoice = 'diff-tab' | 'edit-tab' | 'device-review'

/**
 * How a changed file tapped inside a session opens, read from the host's reply to the tab open.
 * The raw refusal is read because no acceptance policy carries the code and message through.
 */
export function chooseSessionDiffOpen(reply: RpcResponse): SessionDiffOpenChoice {
  // Why: a host with no renderer (orca serve, orcad) cannot open a desktop tab, but the review
  // screen renders the same diff on the device from git.diff (#14315).
  if (isRendererUnavailableRefusal(reply)) {
    return 'device-review'
  }
  // A host too old to open a diff tab still opens the file in an edit tab.
  return isMobileGitUnavailableReply(reply) ? 'edit-tab' : 'diff-tab'
}

/**
 * Opens a changed file as a session tab — a diff tab, or an edit tab on hosts too old for one —
 * or reports that the device has to render it. A refusal throws the host's message.
 */
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
