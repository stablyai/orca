import {
  desktopCapturer,
  webContents,
  type DesktopCapturerSource,
  type DisplayMediaRequestHandlerHandlerRequest,
  type Session,
  type Streams
} from 'electron'
import type { DesktopAppCaptureSource, DesktopAppTarget } from '../../shared/desktop-app-types'
import {
  describeMissingCaptureSource,
  findWindowCaptureSource
} from './desktop-app-capture-source-match'

type ArmedSource = {
  source: DesktopCapturerSource
  key: string
  session: Session
  expiry: NodeJS.Timeout
}

// One armed source per renderer: prepareCapture arms it, the next getDisplayMedia consumes it.
const armedSources = new Map<number, ArmedSource>()
// Windows each renderer has open in a Desktop App pane, counted per pane. Input is only
// accepted for these, and only until the last pane showing the window stops capturing.
const authorizedWindows = new Map<number, Map<string, number>>()
const trackedRenderers = new Set<number>()
// Why: a prepare whose getDisplayMedia never came must not keep granting capture.
const ARMED_SOURCE_TTL_MS = 10_000

/** Arms `target` (already checked against the native window list) for the sender's next getDisplayMedia. */
export async function prepareDesktopAppCapture(
  sender: Electron.WebContents,
  target: DesktopAppTarget
): Promise<DesktopAppCaptureSource> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 }
  })
  const source = findWindowCaptureSource(sources, target.windowId)
  if (!source) {
    throw new Error(describeMissingCaptureSource(target.windowId, sources.length))
  }
  trackRenderer(sender)
  arm(sender, source, windowKey(target))
  const keys = authorizedWindows.get(sender.id) ?? new Map<string, number>()
  authorizedWindows.set(sender.id, keys)
  keys.set(windowKey(target), (keys.get(windowKey(target)) ?? 0) + 1)
  return { sourceId: source.id }
}

/** Undoes one prepareDesktopAppCapture once its pane stops showing the window. */
export function releaseDesktopAppCapture(
  sender: Electron.WebContents,
  target: DesktopAppTarget
): void {
  const key = windowKey(target)
  const keys = authorizedWindows.get(sender.id)
  const count = keys?.get(key) ?? 0
  if (count > 1) {
    keys?.set(key, count - 1)
  } else {
    keys?.delete(key)
  }
  if (armedSources.get(sender.id)?.key === key) {
    disarm(sender.id)
  }
}

/** True while this renderer has a Desktop App window armed for its next getDisplayMedia. */
export function hasArmedDesktopAppCapture(webContentsId: number): boolean {
  return armedSources.has(webContentsId)
}

export function isDesktopAppWindowAuthorized(
  webContentsId: number,
  target: DesktopAppTarget
): boolean {
  return (authorizedWindows.get(webContentsId)?.get(windowKey(target)) ?? 0) > 0
}

function windowKey({ pid, windowId }: DesktopAppTarget): string {
  return `${pid}:${windowId}`
}

function trackRenderer(sender: Electron.WebContents): void {
  if (trackedRenderers.has(sender.id)) {
    return
  }
  trackedRenderers.add(sender.id)
  const id = sender.id
  const forget = (): void => {
    authorizedWindows.delete(id)
    disarm(id)
  }
  // Why: a reloaded or crashed renderer keeps its webContents id but loses its panes, so their
  // releases never come; its authorizations must not outlive the page that took them.
  sender.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      forget()
    }
  })
  sender.on('render-process-gone', forget)
  // Why: registered once per renderer, so repeated prepares do not stack listeners.
  sender.once('destroyed', () => {
    trackedRenderers.delete(id)
    forget()
  })
}

function arm(sender: Electron.WebContents, source: DesktopCapturerSource, key: string): void {
  disarm(sender.id)
  const session = sender.session
  if (![...armedSources.values()].some((armed) => armed.session === session)) {
    session.setDisplayMediaRequestHandler(handleDisplayMediaRequest)
  }
  const expiry = setTimeout(() => disarm(sender.id), ARMED_SOURCE_TTL_MS)
  armedSources.set(sender.id, { source, key, session, expiry })
}

function disarm(webContentsId: number): void {
  const armed = armedSources.get(webContentsId)
  if (!armed) {
    return
  }
  armedSources.delete(webContentsId)
  clearTimeout(armed.expiry)
  if (![...armedSources.values()].some((other) => other.session === armed.session)) {
    // Why: Electron keeps one display-media handler per session and cannot chain them, so this
    // one only exists while a Desktop App capture is pending; afterwards other getDisplayMedia
    // callers get the session's default behavior back.
    armed.session.setDisplayMediaRequestHandler(null)
  }
}

function handleDisplayMediaRequest(
  request: DisplayMediaRequestHandlerHandlerRequest,
  callback: (streams: Streams) => void
): void {
  const requester = request.frame ? webContents.fromFrame(request.frame) : undefined
  const armed = requester ? armedSources.get(requester.id) : undefined
  if (!requester || !armed || !request.videoRequested) {
    // Why: while a pane is armed, only that pane's request may capture; others are denied.
    callback({})
    return
  }
  disarm(requester.id)
  callback({ video: armed.source })
}
