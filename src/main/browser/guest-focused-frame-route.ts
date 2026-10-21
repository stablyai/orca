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

// Why: widget input (sendInputEvent) reaches only the guest's own renderer, so keys meant for a
// focused cross-site iframe would go to the main frame instead. CDP input on that iframe's own
// target session reaches it without moving the user's focus (measured; #20595 follow-up).
// See docs/reference/agent-browser-focus-isolation.md.

export { isOrcaFrameSessionTraffic, settleWithin } from './guest-frame-input-sessions'
export type { GuestSessionCdpSender } from './guest-frame-input-sessions'

/** Where keys for the page's focused element should go. */
export type FocusedFrameRoute =
  | { kind: 'widget' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'unknown' }

// Why: bounds the walk through nested frames; deeper focus takes the fallback.
const MAX_FRAME_DEPTH = 6
const PROBE_OBJECT_GROUP = 'orca-focused-frame-probe'
const PROBE_WORLD_NAME = 'orca-focused-frame-probe'

// Why: returns the focused frame owner itself (through open shadow roots), or null when focus is
// not on one, so its frame id can be read without a second evaluation.
const FOCUSED_FRAME_ELEMENT_EXPRESSION = `(() => {
  let element = document.activeElement
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement
  const tag = element?.tagName
  const owner = tag === 'IFRAME' || tag === 'FRAME' || tag === 'FENCEDFRAME' || tag === 'OBJECT' || tag === 'EMBED'
  return owner ? element : null
})()`

type ProbeSite = { sessionId?: string; contextId?: number; targetId?: string }
type FocusProbe = { outcome: 'ok'; frameId: string | null } | { outcome: 'failed' | 'timeout' }

/** Frame id of the focused frame owner in one document (a session, or a frame's context in it). */
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
    return { outcome: 'ok', frameId: null }
  }
  try {
    const described = await settle(send('DOM.describeNode', { objectId }, at.sessionId))
    return described.outcome === 'ok'
      ? { outcome: 'ok', frameId: readString(readRecord(described.value, 'node'), 'frameId') }
      : described
  } finally {
    void send(
      'Runtime.releaseObjectGroup',
      { objectGroup: PROBE_OBJECT_GROUP },
      at.sessionId
    ).catch(() => undefined)
  }
}

/** An execution context in a same-site frame, so focus inside it can be read. */
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

function routeFor(at: ProbeSite): FocusedFrameRoute {
  return at.sessionId ? { kind: 'session', sessionId: at.sessionId } : { kind: 'widget' }
}

/**
 * Follows the page's focus through frames. A same-site frame shares its parent's renderer, so
 * the parent's route reaches it unless focus continues into a cross-site frame, which gets its
 * own session. Anything this cannot follow is `unknown` and takes the focus-borrowing fallback.
 */
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
        // Why: a cached session dies when the debugger re-attaches; attach once more and retry.
        forgetFrameSession(webContents, at.sessionId)
        reattached = true
        const fresh = await frameSessionFor(webContents, send, at.targetId)
        if (!fresh) {
          return { kind: 'unknown' }
        }
        at = { sessionId: fresh, targetId: at.targetId }
        continue
      }
      // Why: an unreadable main frame (navigation tore down the context) means main-frame focus.
      return at.sessionId || at.contextId !== undefined ? { kind: 'unknown' } : { kind: 'widget' }
    }
    if (!probe.frameId) {
      return routeFor(at)
    }
    let crossSite = await crossSiteFrameTargets(webContents, send, { refresh: false })
    if (!crossSite.has(probe.frameId)) {
      // Why: a frame that just navigated cross-site is missing from a cached list.
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
