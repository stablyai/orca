import type { WebContents } from 'electron'
import { BrowserError } from '../../browser-error'
import {
  readRecord,
  readString,
  settle,
  type CrossSiteFrameTargets,
  type GuestSessionCdpSender,
  type Settled
} from './guest-frame-input-sessions'
import { frameOwnerMapping, type FrameMapping, type Point } from './cross-site-frame-geometry'

// Finds the cross-site frame under a point in one CDP session, for pointer input routing.

const FRAME_OWNER_NODE_NAMES: ReadonlySet<string> = new Set([
  'IFRAME',
  'FRAME',
  'FENCEDFRAME',
  'OBJECT',
  'EMBED'
])

/** Input sent into a frame that stopped answering would wait on it and hold the page's queue. */
export function assertFrameAnswered(
  outcome: Settled<unknown>['outcome'],
  sessionId: string | undefined
) {
  if (outcome === 'timeout' && sessionId !== undefined) {
    throw new BrowserError(
      'browser_input_target_unavailable',
      'The embedded frame under the pointer is not responding, so the input was not sent.'
    )
  }
}

// One layout probe per frame session at a time, and one bounded wait on it: a hung frame never
// answers, and CDP can't cancel, so later inputs share the first wait's outcome.
const pendingLayoutProbes = new Map<string, Promise<Settled<unknown>>>()

function probeLayout(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string | undefined
): Promise<Settled<unknown>> {
  const key = `${webContents.id}:${sessionId ?? ''}`
  let probe = pendingLayoutProbes.get(key)
  if (!probe) {
    const request = send('Page.getLayoutMetrics', {}, sessionId)
    const forget = (): void => {
      pendingLayoutProbes.delete(key)
    }
    void request.then(forget, forget)
    probe = settle(request)
    pendingLayoutProbes.set(key, probe)
  }
  return probe
}

/** Before input reaches a frame session the route already holds, such as a captured drag's. */
export async function assertFrameResponsive(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string
): Promise<void> {
  assertFrameAnswered((await probeLayout(webContents, send, sessionId)).outcome, sessionId)
}

export async function crossSiteFrameAt(
  webContents: WebContents,
  send: GuestSessionCdpSender,
  sessionId: string | undefined,
  point: Point
): Promise<{ frameId: string; mapping: FrameMapping } | null> {
  // getNodeForLocation takes document coordinates, while input is relative to the viewport.
  const metrics = await probeLayout(webContents, send, sessionId)
  assertFrameAnswered(metrics.outcome, sessionId)
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
  assertFrameAnswered(hit.outcome, sessionId)
  const backendNodeId =
    hit.outcome === 'ok' && hit.value !== null && typeof hit.value === 'object'
      ? Object.getOwnPropertyDescriptor(hit.value, 'backendNodeId')?.value
      : undefined
  if (typeof backendNodeId !== 'number') {
    return null
  }
  const described = await settle(send('DOM.describeNode', { backendNodeId }, sessionId))
  assertFrameAnswered(described.outcome, sessionId)
  const node = readRecord(described.outcome === 'ok' ? described.value : null, 'node')
  // A document's root element carries its own frame's id too; only an owner names a child frame.
  const frameId = FRAME_OWNER_NODE_NAMES.has(readString(node, 'nodeName') ?? '')
    ? readString(node, 'frameId')
    : null
  if (!frameId) {
    return null
  }
  const { timedOut, mapping } = await frameOwnerMapping(send, sessionId, backendNodeId)
  assertFrameAnswered(timedOut ? 'timeout' : 'ok', sessionId)
  return mapping ? { frameId, mapping } : null
}

const hostsFrameByTargets = new WeakMap<CrossSiteFrameTargets, Promise<boolean>>()

export function isRecord(value: unknown): value is Record<string, unknown> {
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
export function pageHostsCrossSiteFrame(
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
