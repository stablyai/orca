import { markdownDocumentsFromRelativePaths } from '../../shared/markdown-document-paths'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { requestGitStreamable } from '../ssh/ssh-git-response-stream-reader'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import type { MarkdownDocument } from '../../shared/filesystem-entry-types'
import { assertMarkdownDocumentsWithinLimit } from '../../shared/markdown-document-listing-limits'

export async function readSshMarkdownDocuments(
  mux: SshChannelMultiplexer,
  rootPath: string,
  signal?: AbortSignal,
  loadLegacy?: () => Promise<string[]>
): Promise<MarkdownDocument[]> {
  let result: unknown
  try {
    result = await requestGitStreamable(
      mux,
      'fs.listMarkdownDocuments',
      { rootPath },
      { signal, maxResponseBytes: 16 * 1024 * 1024 }
    )
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      if (loadLegacy) {
        return markdownDocumentsFromRelativePaths(rootPath, await loadLegacy())
      }
      throw new Error('Markdown discovery requires an updated SSH relay. Reconnect and retry.')
    }
    throw error
  }
  assertMarkdownDocumentsWithinLimit(result)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared validator checked every document field and the aggregate budget.
  return result as MarkdownDocument[]
}
