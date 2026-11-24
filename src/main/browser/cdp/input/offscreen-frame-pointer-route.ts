import type { WebContents } from 'electron'
import {
  crossSiteFrameTargets,
  forgetFrameSession,
  frameSessionFor,
  readRecord,
  readString,
  sendFrameSessionInput,
  settle,
  type CrossSiteFrameTargets,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'
import { assertExpectedPageUrlForStep } from './browser-expected-page-url'
import {
  frameOwnerMapping,
  toFrame,
  type FrameMapping,
  type Point
} from './cross-site-frame-geometry'
import { coverFrameSessionWithFileChooserInterception } from './file-chooser-frame-coverage'

// Why: Chromium can't hit-test out-of-process frames on offscreen pages, so page-level CDP mouse
// input over a cross-site frame lands in its parent. Send it to the frame's own session instead.

/** Level i is the frame `frameIds[i]`, reached through `sessions[i]` and mapped by `frames[i]`, outermost first. */
type PointerRoute = {
  frameIds: readonly string[]
  sessions: readonly string[]
  frames: readonly FrameMapping[]
}

const PAGE_ROUTE: PointerRoute = { frameIds: [], sessions: [], frames: [] }
// Same bound as focused-frame key routing; deeper frames fall back to their parent.
const MAX_FRAME_DEPTH = 6
// A press keeps its frame until release, as Chromium's mouse capture does for a drag.
const pressedRouteByGuest = new WeakMap<WebContents, PointerRoute>()
const hoveredRouteByGuest = new WeakMap<WebContents, PointerRoute>()
// Off every frame, so a frame the pointer left clears its hover as Chromium's mouse leave does.
const OFF_FRAME_POINT = { x: -1, y: -1 }

async function crossSiteFrameAt(
  send: GuestSessionCdpSender,
  sessionId: string | undefined,
  point: Point
): Promise<{ frameId: string; mapping: FrameMapping } | null> {
  // getNodeForLocation takes document coordinates, while input is relative to the viewport.
  const metrics = await settle(send('Page.getLayoutMetrics', {}, sessionId))
  const viewport = readRecord(metrics.outcome === 'ok' ? metrics.value : null, 'cssVisualViewport')
  const pageX = viewport?.pageX
  const pageY = viewport?.pageY
  if (typeof pageX !== 'number' || typeof pageY !== 'number') {
    return null
  }
  const hit = await settle(
    send(
      'DOM.getNodeForLocation',
      // The protocol takes integers; input keeps the exact point.
      {
        x: Math.round(point.x + pageX),
        y: Math.round(point.y + pageY),
        includeUserAgentShadowDOM: true
      },
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
  const mapping = await frameOwnerMapping(send, sessionId, backendNodeId)
  return mapping ? { frameId, mapping } : null
}

/** The route's frames through current sessions, cut at the first frame that is gone. */
async function reattachRoute(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  route: PointerRoute
): Promise<PointerRoute> {
  const sessions: string[] = []
  for (const frameId of route.frameIds) {
    const sessionId = await frameSessionFor(webContents, send, frameId)
    if (!sessionId) {
      break
    }
    sessions.push(sessionId)
  }
  return {
    frameIds: route.frameIds.slice(0, sessions.length),
    sessions,
    frames: route.frames.slice(0, sessions.length)
  }
}

/** A captured drag stays in its frames, which may have scrolled or moved since the press. */
async function remapCapturedRoute(
  send: GuestSessionCdpSender,
  route: PointerRoute
): Promise<PointerRoute> {
  const frames: FrameMapping[] = []
  for (const [level, frameId] of route.frameIds.entries()) {
    const parentSessionId = level === 0 ? undefined : route.sessions[level - 1]
    const owner = await settle(send('DOM.getFrameOwner', { frameId }, parentSessionId))
    const backendNodeId =
      owner.outcome === 'ok' && isRecord(owner.value) ? owner.value.backendNodeId : undefined
    const mapping =
      typeof backendNodeId === 'number'
        ? await frameOwnerMapping(send, parentSessionId, backendNodeId)
        : null
    frames.push(mapping ?? route.frames[level])
  }
  return { ...route, frames }
}

const hostsFrameByTargets = new WeakMap<CrossSiteFrameTargets, Promise<boolean>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function collectFrameIds(tree: Record<string, unknown> | null, ids: Set<string>): void {
  const id = readString(readRecord(tree, 'frame'), 'id')
  if (id) {
    ids.add(id)
  }
  const children = tree?.childFrames
  if (Array.isArray(children)) {
    for (const child of children) {
      collectFrameIds(isRecord(child) ? child : null, ids)
    }
  }
}

/** Whether one of this page's own frames hosts a cross-site frame; the target list spans every page. */
function pageHostsCrossSiteFrame(
  send: GuestSessionCdpSender,
  crossSite: CrossSiteFrameTargets
): Promise<boolean> {
  let hosts = hostsFrameByTargets.get(crossSite)
  if (!hosts) {
    // Deeper cross-site frames sit inside one hosted by the page's own frames.
    hosts = settle(send('Page.getFrameTree', {})).then((tree) => {
      if (tree.outcome !== 'ok') {
        return true
      }
      const ids = new Set<string>()
      collectFrameIds(readRecord(tree.value, 'frameTree'), ids)
      return [...crossSite.values()].some((parent) => parent !== null && ids.has(parent))
    })
    hostsFrameByTargets.set(crossSite, hosts)
  }
  return hosts
}

async function resolvePointerRoute(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  point: Point,
  { pressing }: { pressing: boolean }
): Promise<PointerRoute> {
  // A press reads a fresh frame list; moves and wheels reuse it for a second, as key routing does.
  let crossSite = await crossSiteFrameTargets(webContents, send, { refresh: pressing })
  if (crossSite.size === 0 || !(await pageHostsCrossSiteFrame(send, crossSite))) {
    return PAGE_ROUTE
  }
  let route = PAGE_ROUTE
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    const frame = await crossSiteFrameAt(send, route.sessions.at(-1), toFrame(route.frames, point))
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
    route = {
      frameIds: [...route.frameIds, frame.frameId],
      sessions: [...route.sessions, sessionId],
      frames: [...route.frames, frame.mapping]
    }
  }
  return route
}

function isButtonHeld(params: Record<string, unknown>): boolean {
  return typeof params.buttons === 'number' && params.buttons !== 0
}

// Chromium's reply when a frame navigated away or the debugger reattached since the session opened.
function isSessionGone(error: unknown): boolean {
  return error instanceof Error && /session with given id not found/i.test(error.message)
}

/**
 * When the pointer changes frames: frames it left lose hover, and the new frame's ancestors hover
 * its element. `send` checks the expected URL synchronously, so a mismatch escapes `settle`.
 */
async function moveHover(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  route: PointerRoute,
  point: Point
): Promise<void> {
  const previous = hoveredRouteByGuest.get(webContents) ?? PAGE_ROUTE
  if (previous.sessions.at(-1) === route.sessions.at(-1)) {
    return
  }
  hoveredRouteByGuest.set(webContents, route)
  for (const left of previous.sessions.toReversed()) {
    // Its leave can run page handlers too; a frame whose picker can't be caught gets none.
    const covered =
      !route.sessions.includes(left) &&
      (await settle(coverFrameSessionWithFileChooserInterception(webContents, left))).outcome ===
        'ok'
    if (covered) {
      await settle(
        send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...OFF_FRAME_POINT }, left)
      )
    }
  }
  for (let level = 0; level < route.sessions.length; level += 1) {
    const at = toFrame(route.frames.slice(0, level), point)
    await settle(
      send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, route.sessions[level - 1])
    )
  }
}

async function sendToRoute(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  route: PointerRoute,
  params: Record<string, unknown>,
  point: Point
): Promise<unknown> {
  // Routing and each earlier event awaited the page, which may have left the URL this input was
  // meant for; the check throws before the send, so a mismatch stops the whole sequence.
  const sendInput: GuestSessionCdpSender = (method, inputParams, inputSessionId) => {
    assertExpectedPageUrlForStep()
    return send(method, inputParams, inputSessionId)
  }
  // Input activates the frame and its ancestors, and any of them can open a file picker that only
  // its own session can catch, so cover them before the first event reaches any of them.
  for (const frameSessionId of route.sessions) {
    await coverFrameSessionWithFileChooserInterception(webContents, frameSessionId)
  }
  await moveHover(webContents, sendInput, route, point)
  const sessionId = route.sessions.at(-1)
  if (!sessionId) {
    return await sendInput('Input.dispatchMouseEvent', params)
  }
  return await sendFrameSessionInput(
    webContents,
    sendInput,
    sessionId,
    'Input.dispatchMouseEvent',
    {
      ...params,
      ...toFrame(route.frames, point)
    }
  )
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
  const point = { x, y }
  const pressed = pressedRouteByGuest.get(webContents)
  const captured =
    pressed && (type === 'mouseReleased' || (type === 'mouseMoved' && isButtonHeld(params)))
      ? pressed
      : null
  let route = captured
    ? await remapCapturedRoute(send, captured)
    : await resolvePointerRoute(webContents, send, point, { pressing: type === 'mousePressed' })
  try {
    return await sendToRoute(webContents, send, route, params, point)
  } catch (error) {
    if (!isSessionGone(error)) {
      throw error
    }
    // Only the dead session is replaced, so a live one is never orphaned by a rejected event.
    const dead = route.sessions.at(-1)
    if (dead) {
      forgetFrameSession(webContents, dead)
    }
    hoveredRouteByGuest.delete(webContents)
    // A captured drag reattaches to its own frames rather than whatever is under the pointer now.
    route = captured
      ? await remapCapturedRoute(send, await reattachRoute(webContents, send, captured))
      : await resolvePointerRoute(webContents, send, point, { pressing: type === 'mousePressed' })
    return await sendToRoute(webContents, send, route, params, point)
  } finally {
    if (type === 'mouseReleased' && !isButtonHeld(params)) {
      pressedRouteByGuest.delete(webContents)
    } else if (type === 'mousePressed' || captured) {
      // Keeps the remapped or reattached frames, so later held events don't repeat the recovery.
      pressedRouteByGuest.set(webContents, route)
    }
  }
}
