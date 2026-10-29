import { openLocalPreviewGrantFile } from './local-preview-grant-file'
import {
  previewGrantForSender,
  remoteSnapshot,
  revokeGrant,
  type PreviewSender
} from './preview-grant-registry'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import {
  RemotePreviewPairingChangedError,
  readRemotePreviewRange
} from './remote-file-preview-reader'

/** pdf.js asks in 256 KiB chunks but may merge neighbours; the renderer splits anything larger. */
export const PREVIEW_RANGE_READ_MAX_BYTES = 4 * 1024 * 1024

/**
 * A PDF grant's bytes for the renderer that minted it. pdf.js reads ranges here instead of over
 * fetch, so orca-media needs no fetch or CORS privileges and no other page or frame can read them.
 */
export async function readPreviewGrantRange(
  sender: PreviewSender,
  url: string,
  offset: number,
  length: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > PREVIEW_RANGE_READ_MAX_BYTES
  ) {
    throw new Error('Invalid preview range')
  }
  // Per window: its iframes share the id, but only its main frame has the preload API.
  const found = previewGrantForSender(url, sender.id)
  if (!found || found.grant.preview.kind !== 'pdf') {
    throw new Error('Preview is no longer available')
  }
  const { token, grant } = found
  if ('remote' in grant.target) {
    const remote = grant.target.remote
    // A closed window stops its remote chunk reads instead of draining them.
    const lifetime = abortWhenRendererGone(sender)
    try {
      const { size } = await remoteSnapshot(grant, remote)
      return await readRemotePreviewRange(remote, offset, length, size, lifetime.signal)
    } catch (error) {
      if (error instanceof RemotePreviewPairingChangedError) {
        revokeGrant(token)
      }
      throw error
    } finally {
      lifetime.dispose()
    }
  }
  if (grant.target.connectionId) {
    throw new Error('Preview is no longer available')
  }
  const { handle, stats } = await openLocalPreviewGrantFile(grant, grant.target, grant.store)
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(length, stats.size - offset)))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)
  } finally {
    await handle.close()
  }
}
