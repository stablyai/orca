import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'
import { BrowserError } from '../../../browser-error'
import { LOCAL_READ_OPEN_FLAGS } from '../../../../filesystem/local-file-io/local-regular-file-read'

// The desktop's toast offers the copy for 10 s, longer while hovered or hidden; it drops the
// button before this runs out.
const OFFER_UNCLAIMED_MS = 2 * 60_000
// Past this a download gets no offer: hours over a slow link.
export const BROWSER_DOWNLOAD_COPY_MAX_BYTES = 4 * 1024 * 1024 * 1024
// Each is a path and a timer; a page downloading in a loop evicts its oldest offers.
const MAX_OFFERS = 64

/** A finished download this host saved, which one paired device may copy once. */
type CopyOffer = {
  pairedDeviceId: string
  savePath: string
  // The file as it was saved; a file swapped in at that path since is refused.
  identity: Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs'>
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
    expiry: expireOffer(copyId)
  })
  for (const oldestId of offers.keys()) {
    if (offers.size <= MAX_OFFERS) {
      break
    }
    forgetOffer(oldestId)
  }
  return copyId
}

/** The saved file, opened for the device it was offered to; the offer is spent either way. */
export async function claimBrowserDownloadCopy(
  pairedDeviceId: string | undefined,
  copyId: string
): Promise<{ handle: FileHandle; size: number; mtimeMs: number }> {
  const offer = offers.get(copyId)
  if (!offer || offer.pairedDeviceId !== pairedDeviceId) {
    throw new BrowserError(
      'browser_error',
      'This download is no longer available to copy. Download it again.'
    )
  }
  // One-time: a second stream or a replay can't take the file too.
  forgetOffer(copyId)
  // No link may stand in for the saved file, and a pipe put there can't hang the open.
  const handle = await open(
    offer.savePath,
    LOCAL_READ_OPEN_FLAGS | (constants.O_NOFOLLOW ?? 0)
  ).catch(() => {
    throw new BrowserError('browser_error', 'The download could not be read on the server.')
  })
  try {
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
    return { handle, size: identity.size, mtimeMs: identity.mtimeMs }
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
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

function expireOffer(copyId: string): NodeJS.Timeout {
  return setTimeout(() => offers.delete(copyId), OFFER_UNCLAIMED_MS).unref()
}

function forgetOffer(copyId: string): void {
  const offer = offers.get(copyId)
  if (offer) {
    clearTimeout(offer.expiry)
    offers.delete(copyId)
  }
}
