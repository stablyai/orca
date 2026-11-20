import { Directory, File as FsFile, Paths } from 'expo-file-system'
import {
  attachmentTextChunkSchema,
  type AttachmentTextRead
} from '../../../../src/shared/attachment-text/attachment-text-source'
import { MAX_FILE_RANGE_READ_BYTES } from '../../../../src/shared/file-content/file-range-read'
import { decodeBase64Bytes } from '../../transport/encryption/base64-byte-codec'

const DOWNLOAD_FOLDER = 'orca-chat-attachments'

function localFileName(path: string): string {
  const name = path.split(/[\\/]/).at(-1)?.trim() ?? ''
  return name.replace(/[^\w.\- ]+/g, '_') || 'attachment'
}

/** Copies a chat attachment from the host into the phone's cache in chunks, so any size fits; the host's snapshot id fails the copy if the file changes mid-way. */
export async function downloadMobileChatAttachment(
  read: AttachmentTextRead,
  args: {
    path: string
    onProgress?: (fraction: number) => void
    signal?: AbortSignal
  }
): Promise<string> {
  const folder = new Directory(Paths.cache, DOWNLOAD_FOLDER)
  folder.create({ idempotent: true, intermediates: true })
  const file = new FsFile(folder, localFileName(args.path))
  file.create({ overwrite: true })
  const handle = file.open()
  try {
    let offset = 0
    let snapshot: string | undefined
    for (;;) {
      args.signal?.throwIfAborted()
      const chunk = attachmentTextChunkSchema.parse(
        await read(
          {
            path: args.path,
            offset,
            length: MAX_FILE_RANGE_READ_BYTES,
            ...(snapshot ? { expectedSnapshot: snapshot } : {})
          },
          args.signal
        )
      )
      snapshot = chunk.snapshot
      await handle.writeBytes(decodeBase64Bytes(chunk.contentBase64))
      offset += chunk.bytesRead
      args.onProgress?.(chunk.size === 0 ? 1 : offset / chunk.size)
      if (chunk.eof) {
        return file.uri
      }
    }
  } catch (error) {
    handle.close()
    file.delete()
    throw error
  } finally {
    try {
      handle.close()
    } catch {
      // Already closed on the failure path.
    }
  }
}
