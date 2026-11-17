// "Move to this computer": pages the VM's archive down over orcad file RPCs into a local file.
import { createWriteStream } from 'node:fs'
import { CLOUD_TRANSFER_MAX_BYTES } from '../../shared/hosted-sandbox/cloud-transfer-pack'
import { CloudTransferError } from './cloud-transfer-cancel'
import { CHUNK_BYTES, readChunk } from './cloud-transfer-steps'
import type { RuntimeCall } from './hosted-agent-auto-resume'

/** Pages a cloud file to disk; returns bytes written. */
export async function downloadCloudFile(
  call: RuntimeCall,
  worktree: string,
  relativePath: string,
  destination: string,
  onProgress: (bytes: number) => void,
  signal?: AbortSignal
): Promise<number> {
  const out = createWriteStream(destination)
  // A write error (disk full) fails this move instead of crashing main; drain never fires after it.
  let writeError: Error | null = null
  const failed = new Promise<never>((_, reject) =>
    out.on('error', (error) => reject((writeError ??= error)))
  )
  failed.catch(() => undefined)
  let offset = 0
  try {
    for (;;) {
      if (writeError) {
        throw writeError
      }
      signal?.throwIfAborted()
      const page = await readChunk(call, { worktree, relativePath, offset, length: CHUNK_BYTES })
      const bytes = Buffer.from(page.contentBase64, 'base64')
      if (!out.write(bytes)) {
        await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), failed])
      }
      offset += bytes.byteLength
      onProgress(offset)
      if (offset > CLOUD_TRANSFER_MAX_BYTES) {
        throw new CloudTransferError('too_large', 'This workspace is too large to move in one go.')
      }
      if (page.eof || page.bytesRead === 0) {
        return offset
      }
    }
  } finally {
    if (writeError) {
      out.destroy()
    } else {
      await new Promise<void>((resolve) => out.end(resolve))
    }
  }
}
