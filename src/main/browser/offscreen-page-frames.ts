import type { WebContents } from 'electron'
import type { OffscreenPageCdpSession } from './offscreen-page-cdp-session'

type CdpCommand = readonly [method: string, params?: Record<string, unknown>]

/** A point in one frame target: no sessionId is the page itself; x and y are that frame's CSS px. */
export type OffscreenPageFramePoint = { sessionId?: string; x: number; y: number }

export type OffscreenPageMouseParams = Record<string, unknown> & {
  type: string
  x: number
  y: number
  /** Held-button mask after this event; missing means none. */
  buttons?: number
}

// Why flatten: child targets then share the page's debugger, addressed by sessionId.
const AUTO_ATTACH: CdpCommand = [
  'Target.setAutoAttach',
  // Why the agent bridge's exact settings: both set auto-attach on the one debugger connection.
  { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }
]
export const OFFSCREEN_PAGE_FRAME_SETUP = [AUTO_ATTACH] as const

// Why a cap: a hostile page could nest frames without end.
const MAX_DEPTH = 8
// A point outside every frame's viewport: Blink then drops the hover the frame last had.
const OUTSIDE = -1

export type OffscreenPageFrames = {
  /**
   * Sends a mouse event, in main-frame CSS px, to the out-of-process frame under it, or to the one
   * that took the press while buttons stay held. Resolves the reply, undefined without a session.
   */
  sendMouse(params: OffscreenPageMouseParams): Promise<unknown>
  /** The pointer left the page: drops the hover of the frame that had it. */
  leave(): Promise<unknown>
  /** Issues a command only after all earlier input was issued, so it cannot overtake them. */
  inOrder<T>(issue: () => Promise<{ reply: Promise<T> }> | { reply: Promise<T> }): Promise<T>
  /** Where a main-frame CSS px point lands, through every out-of-process frame on the way. */
  locate(x: number, y: number): Promise<OffscreenPageFramePoint>
  /** Hears each mouse event sent to a child frame, in main-frame CSS px. */
  onChildMouse(listener: (params: OffscreenPageMouseParams) => void): () => void
  dispose(): void
}

/**
 * Routes input into an offscreen page's out-of-process iframes. Chromium's offscreen view cannot
 * target them (it only maps points into itself), so input sent to the page lands on the iframe
 * element instead of its content. Orca finds the frame under the point over CDP and sends the
 * event to that frame's own target, in its own coordinates.
 */
export function createOffscreenPageFrames(
  session: OffscreenPageCdpSession,
  childSetup: () => readonly CdpCommand[]
): OffscreenPageFrames {
  const childSessionByFrameId = new Map<string, string>()
  const childListeners = new Set<(params: OffscreenPageMouseParams) => void>()
  let hovered: string | undefined
  let capture: { sessionId?: string; dx: number; dy: number } | null = null
  let order: Promise<unknown> = Promise.resolve()

  const stopMessages = session.onMessage((method, params) => {
    const info = isRecord(params.targetInfo) ? params.targetInfo : null
    if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') {
      if (info?.type === 'iframe' && typeof info.targetId === 'string') {
        // An out-of-process frame's target id is its frame id.
        childSessionByFrameId.set(info.targetId, params.sessionId)
        for (const [command, commandParams] of [AUTO_ATTACH, ...childSetup()]) {
          void session.send(command, commandParams, params.sessionId).catch(() => {})
        }
      }
    } else if (method === 'Target.detachedFromTarget') {
      for (const [frameId, sessionId] of childSessionByFrameId) {
        if (sessionId === params.sessionId) {
          childSessionByFrameId.delete(frameId)
        }
      }
    }
  })

  const childAt = async (
    point: OffscreenPageFramePoint
  ): Promise<OffscreenPageFramePoint | null> => {
    const { sessionId } = point
    const send = (method: string, params: Record<string, unknown>): Promise<unknown> =>
      session.send(method, params, sessionId).catch(() => null)
    const hit = await send('DOM.getNodeForLocation', {
      x: Math.round(point.x),
      y: Math.round(point.y),
      ignorePointerEventsNone: true
    })
    const backendNodeId = isRecord(hit) ? hit.backendNodeId : undefined
    if (typeof backendNodeId !== 'number') {
      return null
    }
    const described = await send('DOM.describeNode', { backendNodeId })
    const frameId = isRecord(described) && isRecord(described.node) ? described.node.frameId : null
    const child = typeof frameId === 'string' ? childSessionByFrameId.get(frameId) : undefined
    if (!child) {
      return null
    }
    const box = await send('DOM.getBoxModel', { backendNodeId })
    const content = isRecord(box) && isRecord(box.model) ? box.model.content : null
    const [left, top] = Array.isArray(content) ? content : []
    return typeof left === 'number' && typeof top === 'number'
      ? { sessionId: child, x: point.x - left, y: point.y - top }
      : null
  }
  /** The frames under a point, outermost first, and the innermost one, which takes the event. */
  const frameChain = async (
    x: number,
    y: number
  ): Promise<{ chain: OffscreenPageFramePoint[]; target: OffscreenPageFramePoint }> => {
    let target: OffscreenPageFramePoint = { x, y }
    const chain = [target]
    while (childSessionByFrameId.size > 0 && chain.length <= MAX_DEPTH) {
      const next = await childAt(target)
      if (!next) {
        break
      }
      target = next
      chain.push(next)
    }
    return { chain, target }
  }

  const inOrder = <T>(
    issue: () =>
      | Promise<{ reply: Promise<T>; settled?: Promise<unknown> }>
      | { reply: Promise<T>; settled?: Promise<unknown> }
  ): Promise<T> => {
    // Why order only the issuing: waiting on replies would hold moves to the page's frame rate.
    const issued = order.then(issue)
    order = issued.then(({ settled }) => settled?.then(noop, noop), noop)
    return issued.then(({ reply }) => reply)
  }
  const moveHover = (to: string | undefined, chain: OffscreenPageFramePoint[]): void => {
    if (to === hovered) {
      return
    }
    // Why: the frame losing the pointer never hears of it; an enclosing frame instead sees the
    // pointer over the frame it moved into.
    const inside = chain.find((point) => point.sessionId === hovered)
    void session
      .send(
        'Input.dispatchMouseEvent',
        { type: 'mouseMoved', x: inside?.x ?? OUTSIDE, y: inside?.y ?? OUTSIDE, button: 'none' },
        hovered
      )
      .catch(() => {})
    hovered = to
  }

  return {
    sendMouse(params) {
      return inOrder(async () => {
        const { chain, target } = capture
          ? captured(capture, params)
          : await frameChain(params.x, params.y)
        moveHover(target.sessionId, chain)
        if (params.type === 'mousePressed') {
          capture ??= {
            sessionId: target.sessionId,
            dx: params.x - target.x,
            dy: params.y - target.y
          }
        } else if (!params.buttons) {
          capture = null
        }
        if (target.sessionId !== undefined) {
          for (const listener of childListeners) {
            listener(params)
          }
        }
        const reply = session.send(
          'Input.dispatchMouseEvent',
          { ...params, x: target.x, y: target.y },
          target.sessionId
        )
        if (params.type !== 'mousePressed') {
          return { reply }
        }
        // Why hold later input: a press can move focus to another frame, and keys go wherever the
        // browser last heard focus was. The frame reports focus on the channel its DevTools
        // replies share, not the input ack's, so one more reply from it proves the news arrived.
        const settled = reply.then(() =>
          session.send('DOM.getNodeForLocation', { x: 0, y: 0 }, target.sessionId)
        )
        return { reply, settled }
      })
    },
    leave() {
      return inOrder(() => {
        capture = null
        moveHover(undefined, [])
        return { reply: Promise.resolve() }
      })
    },
    inOrder,
    async locate(x, y) {
      return (await frameChain(x, y)).target
    },
    onChildMouse(listener) {
      childListeners.add(listener)
      return () => childListeners.delete(listener)
    },
    dispose() {
      stopMessages()
      childListeners.clear()
      childSessionByFrameId.clear()
    }
  }
}

const framesByContents = new WeakMap<WebContents, OffscreenPageFrames>()

/** Lets input from outside Orca's pane, such as an agent's, find the page's frame router. */
export function registerOffscreenPageFrames(
  contents: WebContents,
  frames: OffscreenPageFrames
): () => void {
  framesByContents.set(contents, frames)
  return () => {
    if (framesByContents.get(contents) === frames) {
      framesByContents.delete(contents)
    }
  }
}

/**
 * Sends a CDP mouse event in main-frame CSS px. An offscreen page routes it to the iframe under
 * the point, as a <webview> does on its own.
 */
export function sendPageMouseEvent(
  contents: WebContents,
  params: Record<string, unknown>
): Promise<unknown> {
  const frames = framesByContents.get(contents)
  const { type, x, y, buttons } = params
  if (frames && typeof type === 'string' && typeof x === 'number' && typeof y === 'number') {
    return frames.sendMouse({
      ...params,
      type,
      x,
      y,
      buttons: typeof buttons === 'number' ? buttons : undefined
    })
  }
  return contents.debugger.sendCommand('Input.dispatchMouseEvent', params)
}

function captured(
  capture: { sessionId?: string; dx: number; dy: number },
  params: OffscreenPageMouseParams
): { chain: OffscreenPageFramePoint[]; target: OffscreenPageFramePoint } {
  const target = {
    sessionId: capture.sessionId,
    x: params.x - capture.dx,
    y: params.y - capture.dy
  }
  return { chain: [target], target }
}

function noop(): void {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
