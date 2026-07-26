import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'
import { RelayErrorCode } from '../ssh/relay-protocol'
import { MarkdownDocumentListingCapacityError } from '../../shared/markdown-document-listing-limits'

export async function requestSshMarkdownDocumentPaths(
  mux: SshChannelMultiplexer,
  rootPath: string
): Promise<string[]> {
  try {
    return (await mux.request('fs.listMarkdownDocuments', { rootPath })) as string[]
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === RelayErrorCode.MarkdownDocumentListingCapacity
    ) {
      throw new MarkdownDocumentListingCapacityError()
    }
    if (isMethodNotFoundError(error)) {
      throw new Error(
        'Remote Markdown link discovery is unavailable. Reconnect the SSH target and retry.'
      )
    }
    throw error
  }
}
