import type { WebContents } from 'electron'
import {
  crossSiteFrameTargets,
  forgetFrameSession,
  frameSessionFor,
  readRecord,
  readString,
  settle,
  type GuestSessionCdpSender
} from './guest-frame-input-sessions'

// Cross-site frames need their own CDP session; widget input only reaches the guest renderer.

export type FocusedFrameRoute =
  // Electron's native insertText crashes the guest unless a local frame holds focus.
  | { kind: 'widget'; hasFocusedLocalFrame: boolean }
  | { kind: 'session'; sessionId: string }
  | { kind: 'unknown' }

// Refuse input if deeper nesting prevents a direct route.
const MAX_FRAME_DEPTH = 6
const PROBE_OBJECT_GROUP = 'orca-focused-frame-probe'
const PROBE_WORLD_NAME = 'orca-focused-frame-probe'

const FOCUSED_FRAME_ELEMENT_EXPRESSION = `(() => {
  let element = document.activeElement
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
  const tag = element?.tagName
  const owner = tag === 'IFRAME' || tag === 'FRAME' || tag === 'FENCEDFRAME' || tag === 'OBJECT' || tag === 'EMBED'
  // A body active element can mean no frame has focus, so only a focused element proves it.
  return owner ? element : Boolean(element) && element !== document.body && element !== document.documentElement
})()`

type ProbeSite = { sessionId?: string; contextId?: number; targetId?: string }
type FocusProbe =
  | { outcome: 'ok'; frameId: string | null; focusedElement: boolean }
  | { outcome: 'failed' | 'timeout' }

async function probeFocusedFrame(send: GuestSessionCdpSender, at: ProbeSite): Promise<FocusProbe> {
  const evaluated = await settle(
    send(
      'Runtime.evaluate',
      {
        expression: FOCUSED_FRAME_ELEMENT_EXPRESSION,
        objectGroup: PROBE_OBJECT_GROUP,
        ...(at.contextId === undefined ? {} : { contextId: at.contextId })
      },
      at.sessionId
    )
  )
  if (evaluated.outcome !== 'ok') {
    return evaluated
  }
  const result = readRecord(evaluated.value, 'result')
  if (!result) {
    return { outcome: 'failed' }
  }
  const objectId = readString(result, 'objectId')
  if (!objectId) {
    return { outcome: 'ok', frameId: null, focusedElement: result.value === true }
  }
  try {
    const described = await settle(send('DOM.describeNode', { objectId }, at.sessionId))
    return described.outcome === 'ok'
      ? {
          outcome: 'ok',
          frameId: readString(readRecord(described.value, 'node'), 'frameId'),
          focusedElement: false
        }
      : described
  } finally {
    void send(
      'Runtime.releaseObjectGroup',
      { objectGroup: PROBE_OBJECT_GROUP },
      at.sessionId
    ).catch(() => undefined)
  }
}

async function frameContext(
  send: GuestSessionCdpSender,
  sessionId: string | undefined,
  frameId: string
): Promise<number | null> {
  const created = await settle(
    send('Page.createIsolatedWorld', { frameId, worldName: PROBE_WORLD_NAME }, sessionId)
  )
  if (created.outcome !== 'ok' || created.value === null || typeof created.value !== 'object') {
    return null
  }
  const contextId: unknown = Object.getOwnPropertyDescriptor(
    created.value,
    'executionContextId'
  )?.value
  return typeof contextId === 'number' ? contextId : null
}

function routeFor(at: ProbeSite, focusedElement: boolean): FocusedFrameRoute {
  if (at.sessionId) {
    return { kind: 'session', sessionId: at.sessionId }
  }
  // Entering a same-site frame through its focused owner proves that frame holds focus.
  return { kind: 'widget', hasFocusedLocalFrame: focusedElement || at.contextId !== undefined }
}

/** Follow focus through same-site contexts and cross-site sessions. */
export async function resolveFocusedFrameRoute(
  webContents: WebContents,
  send: GuestSessionCdpSender
): Promise<FocusedFrameRoute> {
  let at: ProbeSite = {}
  let reattached = false
  for (let depth = 0; depth < MAX_FRAME_DEPTH; depth += 1) {
    const probe = await probeFocusedFrame(send, at)
    if (probe.outcome !== 'ok') {
      const deadSession = probe.outcome === 'failed' && at.contextId === undefined
      if (deadSession && at.sessionId && at.targetId && !reattached) {
        // Debugger reattachment invalidates cached sessions; retry once with a fresh attach.
        forgetFrameSession(webContents, at.sessionId)
        reattached = true
        const fresh = await frameSessionFor(webContents, send, at.targetId)
        if (!fresh) {
          return { kind: 'unknown' }
        }
        at = { sessionId: fresh, targetId: at.targetId }
        continue
      }
      // Navigation can invalidate the root probe; widget keys still reach the guest, but text cannot
      // confirm a focused frame.
      return at.sessionId || at.contextId !== undefined
        ? { kind: 'unknown' }
        : { kind: 'widget', hasFocusedLocalFrame: false }
    }
    if (!probe.frameId) {
      return routeFor(at, probe.focusedElement)
    }
    let crossSite = await crossSiteFrameTargets(webContents, send, { refresh: false })
    if (!crossSite.has(probe.frameId)) {
      // Navigation can add a cross-site frame after the target list was cached.
      crossSite = await crossSiteFrameTargets(webContents, send, { refresh: true })
    }
    if (crossSite.has(probe.frameId)) {
      const sessionId = await frameSessionFor(webContents, send, probe.frameId)
      if (!sessionId) {
        return { kind: 'unknown' }
      }
      at = { sessionId, targetId: probe.frameId }
      reattached = false
      continue
    }
    const contextId = await frameContext(send, at.sessionId, probe.frameId)
    if (contextId === null) {
      return { kind: 'unknown' }
    }
    at = { ...at, contextId }
  }
  return { kind: 'unknown' }
}
