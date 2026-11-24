import {
  assertClipboardImageBase64LengthWithinLimit,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../../shared/clipboard/clipboard-image'
import { detectImageFileExtension } from '../../../shared/file-content/image-file-signature'
import {
  fetchRemoteRepoIcon,
  runtimeIconFetch,
  type RepoIconFetch
} from '../../runtime/sidebar-inputs/repo-icons/repo-icon-remote-fetch'

const DROPPED_WEB_IMAGE_FETCH_TIMEOUT_MS = 15_000
const IMAGE_DATA_URL = /^data:image\/[\w.+-]+((?:;[^,;]*)*?)(;base64)?,(.*)$/is

function decodeImageDataUrl(url: string): Buffer | null {
  const match = IMAGE_DATA_URL.exec(url)
  if (!match) {
    return null
  }
  const [, , base64, payload = ''] = match
  if (base64) {
    assertClipboardImageBase64LengthWithinLimit(payload.length)
    return Buffer.from(payload, 'base64')
  }
  try {
    return Buffer.from(decodeURIComponent(payload), 'latin1')
  } catch {
    return null
  }
}

/** Bytes of an image dragged out of a web page: an inline data URL, or HTTPS fetched without cookies. */
export async function readDroppedWebImage(
  url: unknown,
  fetch: RepoIconFetch = runtimeIconFetch
): Promise<Buffer | null> {
  if (typeof url !== 'string') {
    return null
  }
  const bytes = /^data:/i.test(url)
    ? decodeImageDataUrl(url)
    : (
        await fetchRemoteRepoIcon(
          url,
          fetch,
          DROPPED_WEB_IMAGE_FETCH_TIMEOUT_MS,
          undefined,
          CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
        )
      )?.bytes
  // The page's word for the type is not trusted; only real image bytes become an attachment.
  return bytes && bytes.byteLength > 0 && detectImageFileExtension(bytes)
    ? Buffer.from(bytes)
    : null
}
