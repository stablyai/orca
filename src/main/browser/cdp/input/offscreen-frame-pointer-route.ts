import type { WebContents } from 'electron'
import {
  crossSiteFrameTargets,
  forgetFrameSession,
  frameSessionFor,
  readRecord,
  readString,
  sendFrameSessionInput,
  settle,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'

// Why: Chromium can't hit-test out-of-process frames on offscreen pages, so page-level CDP mouse
// input over a cross-site frame lands in its parent. Send it to the frame's own session instead.

type PointerRoute = { sessionId?: string; left: number; top: number }

const PAGE_ROUTE: PointerRoute = { left: 0, top: 0 }
// Same bound as focused-frame key routing; deeper frames fall back to their parent.
const MAX_FRAME_DEPTH = 6
// A press keeps its frame until release, as Chromium's mouse capture does for a drag.
const pressedRouteByGuest = new WeakMap<WebContents, PointerRoute>()
const hoveredFrameSessionByGuest = new WeakMap<WebContents, string>()
// Off every frame, so a frame the pointer left clears its hover as Chromium's mouse leave does.
const OFF_FRAME_POINT = { x: -1, y: -1 }

async function crossSiteFrameAt(
  send: GuestSessionCdpSender,
  sessionId: string | undefined,
  x: number,
  y: number
): Promise<{ frameId: string; left: number; top: number } | null> {
  const hit = await settle(
    send(
      'DOM.getNodeForLocation',
      { x, y, includeUserAgentShadowDOM: true, ignorePointerEventsNone: true },
      sessionId
    )
  )
  const backendNodeId =
    hit.outcome === 'ok' && hit.value !== null && typeof hit.value === 'object'
      ? Object.getOwnPropertyDescriptor(hit.value, 'backendNodeId')?.value
      : undefined
  if (typeof backendNodeId !== 'number') {
    return null
  }
  const described = await settle(send('DOM.describeNode', { backendNodeId }, sessionId))
  // Only frame owners carry a frameId: the frame they host.
  const frameId =
    described.outcome === 'ok' ? readString(readRecord(described.value, 'node'), 'frameId') : null
  if (!frameId) {
    return null
  }
  const box = await settle(send('DOM.getBoxModel', { backendNodeId }, sessionId))
  // The content box's top-left corner is the frame's viewport origin in its parent.
  const quad = readRecord(box.outcome === 'ok' ? box.value : null, 'model')?.content
  if (!Array.isArray(quad) || typeof quad[0] !== 'number' || typeof quad[1] !== 'number') {
    return null
  }
  return { frameId, left: quad[0], top: quad[1] }
}

async function resolvePointerRoute(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  x: number,
  y: number
): Promise<PointerRoute> {
  let crossSite = await crossSiteFrameTargets(webContents, send, { refresh: false })
  if (crossSite.size === 0) {
    return PAGE_ROUTE
  }
  let route = PAGE_ROUTE
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    const frame = await crossSiteFrameAt(send, route.sessionId, x - route.left, y - route.top)
    if (!frame) {
      return route
    }
    if (!crossSite.has(frame.frameId)) {
      // A frame that just loaded may be missing from the cached target list.
      crossSite = await crossSiteFrameTargets(webContents, send, { refresh: true })
      if (!crossSite.has(frame.frameId)) {
        return route
      }
    }
    const sessionId = await frameSessionFor(webContents, send, frame.frameId)
    if (!sessionId) {
      return route
    }
    route = { sessionId, left: route.left + frame.left, top: route.top + frame.top }
  }
  return route
}

function isButtonHeld(params: Record<string, unknown>): boolean {
  return typeof params.buttons === 'number' && params.buttons !== 0
}

/** Page-level Input.dispatchMouseEvent for an offscreen page, delivered to the frame under the pointer. */
export async function sendOffscreenPagePointerInput(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  params: Record<string, unknown>
): Promise<unknown> {
  const { type, x, y } = params
  if (typeof x !== 'number' || typeof y !== 'number') {
    return await send('Input.dispatchMouseEvent', params)
  }
  const pressed = pressedRouteByGuest.get(webContents)
  const route =
    pressed && (type === 'mouseReleased' || (type === 'mouseMoved' && isButtonHeld(params)))
      ? pressed
      : await resolvePointerRoute(webContents, send, x, y)
  if (type === 'mousePressed') {
    pressedRouteByGuest.set(webContents, route)
  } else if (type === 'mouseReleased' && !isButtonHeld(params)) {
    pressedRouteByGuest.delete(webContents)
  }
  const leftSessionId = hoveredFrameSessionByGuest.get(webContents)
  if (leftSessionId && leftSessionId !== route.sessionId) {
    hoveredFrameSessionByGuest.delete(webContents)
    await settle(
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...OFF_FRAME_POINT }, leftSessionId)
    )
  }
  if (!route.sessionId) {
    return await send('Input.dispatchMouseEvent', params)
  }
  hoveredFrameSessionByGuest.set(webContents, route.sessionId)
  try {
    return await sendFrameSessionInput(
      webContents,
      send,
      route.sessionId,
      'Input.dispatchMouseEvent',
      {
        ...params,
        x: x - route.left,
        y: y - route.top
      }
    )
  } catch {
    // A navigated or detached frame drops its session; the page still takes the event.
    forgetFrameSession(webContents, route.sessionId)
    hoveredFrameSessionByGuest.delete(webContents)
    return await send('Input.dispatchMouseEvent', params)
  }
}
