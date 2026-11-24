import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import type { RuntimeFileReadChunkResult } from '../../../../../shared/file-content/runtime-file-read'
import { BrowserError } from '../../../browser-error'
import { LOCAL_READ_OPEN_FLAGS } from '../../../../filesystem/local-file-io/local-regular-file-read'

// Each reply is one frame on the connection other calls share; a small slice keeps a slow link's
// other replies waiting seconds, not tens of seconds (file downloads read 384 KiB).
const COPY_READ_CHUNK_BYTES = 512 * 1024
// The desktop's toast offers the copy for 10 s, longer while hovered or hidden; it drops the
// button before this runs out.
const OFFER_UNCLAIMED_MS = 2 * 60_000
// Between reads once a copy runs; a stalled desktop frees it.
const OFFER_IDLE_MS = 60_000
// Past this a download gets no offer: hours over a slow link.
export const BROWSER_DOWNLOAD_COPY_MAX_BYTES = 4 * 1024 * 1024 * 1024
// Each is a path and a timer; a page downloading in a loop evicts its oldest unread offers.
const MAX_OFFERS = 64

/** A finished download this host saved, which one paired device may copy once. */
type CopyOffer = {
  pairedDeviceId: string
  savePath: string
  // The file as it was saved; a file swapped in at that path since is refused.
  identity: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>
  nextOffset: number
  reading: boolean
  expiry: NodeJS.Timeout
}

const offers = new Map<string, CopyOffer>()

/**
 * Offers the device that heard the download finish a one-time copy of the file this host saved.
 * Null when it is not a regular file here or is past the size cap.
 */
export async function offerBrowserDownloadCopy(
  pairedDeviceId: string,
  savePath: string
): Promise<string | null> {
  let stats: Stats
  try {
    stats = await lstat(savePath)
  } catch {
    return null
  }
  if (!stats.isFile() || stats.size > BROWSER_DOWNLOAD_COPY_MAX_BYTES) {
    return null
  }
  const copyId = randomUUID()
  offers.set(copyId, {
    pairedDeviceId,
    savePath,
    identity: { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs },
    nextOffset: 0,
    reading: false,
    expiry: expireOffer(copyId, OFFER_UNCLAIMED_MS)
  })
  for (const [oldestId, offer] of offers) {
    if (offers.size <= MAX_OFFERS) {
      break
    }
    if (offer.nextOffset === 0 && !offer.reading) {
      forgetOffer(oldestId)
    }
  }
  return copyId
}

/** The next slice, in order, for the device the copy was offered to; the last slice ends the offer. */
export async function readBrowserDownloadCopy(
  pairedDeviceId: string | undefined,
  params: { copyId: string; offset: number }
): Promise<RuntimeFileReadChunkResult> {
  const offer = offers.get(params.copyId)
  if (!offer || offer.pairedDeviceId !== pairedDeviceId) {
    throw new BrowserError(
      'browser_error',
      'This download is no longer available to copy. Download it again.'
    )
  }
  // One reader, in order: a second reader or a replayed slice can't take the file too.
  if (offer.reading || params.offset !== offer.nextOffset) {
    throw new BrowserError('browser_error', 'This download is already being copied.')
  }
  offer.reading = true
  clearTimeout(offer.expiry)
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    // No link may stand in for the saved file, and a pipe put there can't hang the open.
    handle = await open(offer.savePath, LOCAL_READ_OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0))
    const stats = await handle.stat()
    const { identity } = offer
    if (
      !stats.isFile() ||
      stats.dev !== identity.dev ||
      stats.ino !== identity.ino ||
      stats.size !== identity.size ||
      stats.mtimeMs !== identity.mtimeMs
    ) {
      throw new BrowserError(
        'browser_error',
        'The download changed on the server after it was saved. Download it again.'
      )
    }
    const length = Math.min(COPY_READ_CHUNK_BYTES, identity.size - offer.nextOffset)
    const chunk = Buffer.alloc(Math.max(0, length))
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, offer.nextOffset)
    if (bytesRead !== chunk.length) {
      throw new BrowserError('browser_error', 'The download could not be read on the server.')
    }
    offer.nextOffset += bytesRead
    const eof = offer.nextOffset >= identity.size
    if (eof) {
      forgetOffer(params.copyId)
    } else {
      offer.reading = false
      offer.expiry = expireOffer(params.copyId, OFFER_IDLE_MS)
    }
    return { contentBase64: chunk.toString('base64'), bytesRead, eof }
  } catch (error) {
    forgetOffer(params.copyId)
    if (error instanceof BrowserError) {
      throw error
    }
    throw new BrowserError('browser_error', 'The download could not be read on the server.')
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** The device won't copy it (cancelled, failed, or its toast closed). */
export function releaseBrowserDownloadCopy(
  pairedDeviceId: string | undefined,
  params: { copyId: string }
): { released: boolean } {
  if (offers.get(params.copyId)?.pairedDeviceId !== pairedDeviceId) {
    return { released: false }
  }
  forgetOffer(params.copyId)
  return { released: true }
}

function expireOffer(copyId: string, ms: number): NodeJS.Timeout {
  return setTimeout(() => offers.delete(copyId), ms).unref()
}

function forgetOffer(copyId: string): void {
  const offer = offers.get(copyId)
  if (offer) {
    clearTimeout(offer.expiry)
    offers.delete(copyId)
  }
}
