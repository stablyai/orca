import type { WebContents } from 'electron'
import { BrowserError } from '../../browser-error'
import { acquireElectronDebugger } from '../debugger/electron-debugger-lease'
import { sendGuestCdpCommand } from '../debugger/guest-cdp-command'

type CdpFrameResourceTree = {
  frame: { id: string; url: string; mimeType?: string }
  childFrames?: CdpFrameResourceTree[]
  resources?: { url: string; mimeType?: string }[]
}

function findImageResource(
  tree: CdpFrameResourceTree,
  url: string
): { frameId: string; mimeType: string } | null {
  // An image opened as the page itself is the frame's own document, not one of its resources.
  if (tree.frame.url === url) {
    return { frameId: tree.frame.id, mimeType: tree.frame.mimeType ?? '' }
  }
  const resource = tree.resources?.find((candidate) => candidate.url === url)
  if (resource) {
    return { frameId: tree.frame.id, mimeType: resource.mimeType ?? '' }
  }
  for (const child of tree.childFrames ?? []) {
    const found = findImageResource(child, url)
    if (found) {
      return found
    }
  }
  return null
}

/** The bytes of an image the page already loaded, from its own cache, so cross-origin and signed-in images read as shown. */
export async function readGuestImageContent(
  guest: WebContents,
  url: string
): Promise<{ mimeType: string; bytes: Buffer }> {
  if (url.startsWith('data:')) {
    const response = await fetch(url)
    return {
      mimeType: response.headers.get('content-type') ?? '',
      bytes: Buffer.from(await response.arrayBuffer())
    }
  }
  const { release } = acquireElectronDebugger(guest)
  try {
    await sendGuestCdpCommand(guest, 'Page.enable')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Page.getResourceTree always answers with frameTree.
    const { frameTree } = (await sendGuestCdpCommand(guest, 'Page.getResourceTree')) as {
      frameTree: CdpFrameResourceTree
    }
    const resource = findImageResource(frameTree, url)
    if (!resource) {
      throw new BrowserError('browser_error', 'The image is no longer loaded in the page.')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Page.getResourceContent always answers with content and base64Encoded.
    const { content, base64Encoded } = (await sendGuestCdpCommand(
      guest,
      'Page.getResourceContent',
      { frameId: resource.frameId, url }
    )) as { content: string; base64Encoded: boolean }
    return {
      mimeType: resource.mimeType,
      bytes: Buffer.from(content, base64Encoded ? 'base64' : 'utf8')
    }
  } finally {
    release()
  }
}
