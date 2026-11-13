import { base64DecodedByteLength } from '../../../../src/shared/agent-session/agent-session-attachments'
import type { PickedMobileFile } from '../../platform/media-picker-contract'
import { RpcIncompatibleReplyError } from '../../transport/rpc/rpc-incompatible-reply-error'

// DOMException is not a global in the native app; build the AbortError the way the bridge does.
export function uploadAborted(): Error {
  return Object.assign(new Error('The upload was cancelled'), { name: 'AbortError' })
}

/**
 * The host answered and refused, as opposed to a request that never got a reply. `ssh-workspace`:
 * the host does not take files for an SSH worktree. `hostMessage` is empty when the reply was unreadable.
 */
export class MobileFileUploadRefusedError extends Error {
  constructor(
    readonly hostMessage: string,
    readonly reason: 'host' | 'ssh-workspace' = 'host'
  ) {
    super(hostMessage || 'The host refused the file')
    this.name = 'MobileFileUploadRefusedError'
  }
}

/**
 * Interprets a reply that has arrived, so its failure is the host's; a transport rejection never
 * reaches here because it rejects the request promise itself.
 */
export function interpretUploadReply<T>(interpret: () => T): T {
  try {
    return interpret()
  } catch (error) {
    throw new MobileFileUploadRefusedError(
      error instanceof Error && !(error instanceof RpcIncompatibleReplyError) ? error.message : ''
    )
  }
}

/**
 * Sends the file chunk by chunk as it is read; signal is checked before every append and before
 * commit. Any failure aborts the slot and is rethrown: an append is never retried, because the host
 * does not check partial writes.
 */
export async function uploadFileInChunks<TStored>(args: {
  file: PickedMobileFile
  signal?: AbortSignal
  onProgress?: (sentBytes: number) => void
  start: () => Promise<string>
  append: (uploadId: string, offset: number, contentBase64: string) => Promise<void>
  commit: (uploadId: string) => Promise<TStored>
  abort: (uploadId: string) => Promise<void>
}): Promise<TStored> {
  const { file, signal } = args
  if (signal?.aborted) {
    throw uploadAborted()
  }
  const uploadId = await args.start()
  try {
    let sent = 0
    const append = async (contentBase64: string): Promise<void> => {
      if (signal?.aborted) {
        throw uploadAborted()
      }
      await args.append(uploadId, sent, contentBase64)
      sent += base64DecodedByteLength(contentBase64)
      args.onProgress?.(sent)
    }
    let appended = false
    for await (const contentBase64 of file.chunks()) {
      await append(contentBase64)
      appended = true
    }
    if (!appended) {
      // Even an empty file needs one empty append before commit.
      await append('')
    }
    if (signal?.aborted) {
      throw uploadAborted()
    }
    return await args.commit(uploadId)
  } catch (error) {
    await args.abort(uploadId).catch(() => {})
    throw error
  }
}
