import type {
  BrowserPagePromptRequest,
  BrowserStreamedPagePromptKind
} from '../../../../shared/browser/prompts/browser-page-prompt'

type StreamedPagePromptRequest = BrowserPagePromptRequest<BrowserStreamedPagePromptKind>

/** A device streaming a server page; only a device shown a prompt may answer it. */
export type BrowserPagePromptViewer = {
  pairedDeviceId: string
  show: (request: StreamedPagePromptRequest) => void
  close: (requestId: string) => void
}

const viewersByGuestId = new Map<number, Set<BrowserPagePromptViewer>>()
const openPrompts = new Map<
  string,
  { guestWebContentsId: number; request: StreamedPagePromptRequest }
>()

/** A server page has no window; the devices streaming it, if any, ask instead. */
export function browserPagePromptStreamTarget(guestWebContentsId: number): 'stream-viewers' | null {
  return viewersByGuestId.has(guestWebContentsId) ? 'stream-viewers' : null
}

/** False when no device streams the page, so nobody was asked. */
export function showStreamedBrowserPagePrompt(
  guestWebContentsId: number,
  request: StreamedPagePromptRequest
): boolean {
  const viewers = viewersByGuestId.get(guestWebContentsId)
  if (!viewers) {
    return false
  }
  openPrompts.set(request.requestId, { guestWebContentsId, request })
  for (const viewer of viewers) {
    viewer.show(request)
  }
  return true
}

/** Answered, timed out or gone: every viewer puts it away. */
export function closeStreamedBrowserPagePrompt(requestId: string): void {
  const prompt = openPrompts.get(requestId)
  if (!prompt) {
    return
  }
  openPrompts.delete(requestId)
  for (const viewer of viewersByGuestId.get(prompt.guestWebContentsId) ?? []) {
    viewer.close(requestId)
  }
}

export function mayAnswerStreamedBrowserPagePrompt(
  requestId: string,
  pairedDeviceId: string | undefined
): boolean {
  const prompt = openPrompts.get(requestId)
  const viewers = prompt ? (viewersByGuestId.get(prompt.guestWebContentsId) ?? []) : []
  return (
    pairedDeviceId !== undefined &&
    [...viewers].some((viewer) => viewer.pairedDeviceId === pairedDeviceId)
  )
}

/** A joining viewer also sees the page's open prompts, so a reconnect picks them up before they time out. */
export function addBrowserPagePromptViewer(
  guestWebContentsId: number,
  viewer: BrowserPagePromptViewer
): () => void {
  let viewers = viewersByGuestId.get(guestWebContentsId)
  if (!viewers) {
    viewers = new Set()
    viewersByGuestId.set(guestWebContentsId, viewers)
  }
  viewers.add(viewer)
  for (const prompt of openPrompts.values()) {
    if (prompt.guestWebContentsId === guestWebContentsId) {
      viewer.show(prompt.request)
    }
  }
  return () => {
    viewers.delete(viewer)
    if (viewers.size === 0 && viewersByGuestId.get(guestWebContentsId) === viewers) {
      viewersByGuestId.delete(guestWebContentsId)
    }
  }
}
