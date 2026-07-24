import { isFileExistsErrorMessage } from '../session/mobile-session-route-helpers'
import type { RpcClient } from '../transport/rpc-client'
import {
  assertMobileFileMutationFenceCurrent,
  assertMobileFileMutationResponseRuntime,
  captureMobileFileMutationOwnership,
  getMobileFileMutationFailureMessage
} from './mobile-file-mutation-ownership'

const FILE_MUTATION_TIMEOUT_MS = 15_000
const MAX_UNTITLED_MARKDOWN_ATTEMPTS = 100

export async function createAndOpenMobileMarkdownNote(
  client: Pick<RpcClient, 'sendRequest'>,
  worktree: string
): Promise<string> {
  // One user operation keeps one lease so reconnects cannot silently authorize a later collision retry.
  const fence = await captureMobileFileMutationOwnership(client, worktree)
  for (let attempt = 1; attempt <= MAX_UNTITLED_MARKDOWN_ATTEMPTS; attempt += 1) {
    const relativePath = attempt === 1 ? 'untitled.md' : `untitled-${attempt}.md`
    assertMobileFileMutationFenceCurrent(client, fence)
    const createResponse = await client.sendRequest(
      'files.createFile',
      { worktree, relativePath, ...fence.ownership },
      { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
    )
    assertMobileFileMutationResponseRuntime(fence, createResponse)
    if (!createResponse.ok) {
      const message = getMobileFileMutationFailureMessage(createResponse)
      if (isFileExistsErrorMessage(message) && attempt < MAX_UNTITLED_MARKDOWN_ATTEMPTS) {
        continue
      }
      throw new Error(message || 'Failed to create markdown note')
    }

    assertMobileFileMutationFenceCurrent(client, fence)
    const openResponse = await client.sendRequest(
      'files.open',
      { worktree, relativePath },
      { timeoutMs: FILE_MUTATION_TIMEOUT_MS }
    )
    assertMobileFileMutationResponseRuntime(fence, openResponse)
    if (!openResponse.ok) {
      throw new Error(getMobileFileMutationFailureMessage(openResponse))
    }
    return relativePath
  }
  throw new Error('Unable to create untitled markdown note')
}
