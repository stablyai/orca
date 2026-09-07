import type {
  DocPreviewFileAccessRequest,
  DocPreviewFileAccessResult
} from '../../shared/doc-preview-file-access'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

const REMOTE_DOC_PREVIEW_UPDATE_REQUIRED =
  'Secure document previews require a newer SSH relay. Reconnect the SSH target and try again.'

export async function readSshDocPreviewFile(
  mux: SshChannelMultiplexer,
  request: DocPreviewFileAccessRequest
): Promise<DocPreviewFileAccessResult> {
  try {
    return (await mux.request('fs.readDocPreview', request)) as DocPreviewFileAccessResult
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      throw new Error(REMOTE_DOC_PREVIEW_UPDATE_REQUIRED)
    }
    throw error
  }
}
