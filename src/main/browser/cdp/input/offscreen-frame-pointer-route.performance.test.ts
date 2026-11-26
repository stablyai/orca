import type { WebContents } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendOffscreenPagePointerInput } from './offscreen-frame-pointer-route'

// #48525 STA-18087: a click on a Server page must not list every browser target for each press.

type Sent = { method: string; params: Record<string, unknown> }
type Hit = { nodeName: string; frameId?: string }
/** What the page's own hit test finds, and how long each page probe takes. */
type Page = { hit: Hit; probeMs?: number }

const CROSS_SITE_FRAME = { targetId: 'oopif', type: 'iframe', parentFrameId: 'main' }

/** A browser holding `otherTargets` unrelated pages and workers, plus the page's own frame if it hits one. */
function fakeBrowser(otherTargets: number, { hit, probeMs = 0 }: Page) {
  const sent: Sent[] = []
  const listed = { listings: 0, records: 0 }
  const targetInfos = [
    ...Array.from({ length: otherTargets }, (_, i) => ({
      targetId: `other-${i}`,
      type: i % 2 === 0 ? 'page' : 'service_worker'
    })),
    ...(hit.frameId === CROSS_SITE_FRAME.targetId ? [CROSS_SITE_FRAME] : [])
  ]
  const send = async (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string
  ): Promise<unknown> => {
    sent.push({ method, params })
    if (method.startsWith('DOM.') || method === 'Page.getLayoutMetrics') {
      // A busy renderer: the clock moves on while the probe runs, without firing its timeout.
      vi.setSystemTime(Date.now() + probeMs)
    }
    switch (method) {
      case 'Target.getTargets': {
        const types = Array.isArray(params.filter)
          ? new Set(params.filter.map((entry: { type?: string }) => entry.type))
          : null
        const listedInfos = targetInfos.filter((info) => !types || types.has(info.type))
        listed.listings += 1
        listed.records += listedInfos.length
        return { targetInfos: listedInfos }
      }
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'main' } } }
      case 'Page.getLayoutMetrics':
        return { cssVisualViewport: { pageX: 0, pageY: 0 } }
      case 'DOM.getNodeForLocation':
        return { backendNodeId: 1 }
      case 'DOM.describeNode':
        // Inside the frame the pointer is over a button.
        return { node: sessionId ? { nodeName: 'BUTTON' } : hit }
      case 'DOM.getBoxModel': {
        const quad = [0, 0, 100, 0, 100, 100, 0, 100]
        return { model: { content: quad, border: quad, width: 100, height: 100 } }
      }
      default:
        return {}
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the route reads only `id` and keys WeakMaps by the guest.
  const guest = { id: otherTargets } as unknown as WebContents
  return { sent, listed, send, guest }
}

async function targetListingsForClicks(
  otherTargets: number,
  { clicks, types, ...page }: Page & { clicks: number; types: string[] }
): Promise<{ listings: number; records: number }> {
  const { sent, listed, send, guest } = fakeBrowser(otherTargets, page)
  for (let click = 0; click < clicks; click += 1) {
    for (const type of types) {
      await sendOffscreenPagePointerInput(guest, send, {
        type,
        x: 10,
        y: 10,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0
      })
    }
    vi.advanceTimersByTime(3_000)
  }
  expect(sent.filter((s) => s.method === 'Input.dispatchMouseEvent')).toHaveLength(
    clicks * types.length
  )
  return listed
}

describe('offscreen pointer routing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Only the move's once-a-second check lists targets; the press over a button lists none.
  it('lists targets once per click and reads no unrelated target descriptors', async () => {
    const click = {
      clicks: 10,
      hit: { nodeName: 'BUTTON' },
      types: ['mouseMoved', 'mousePressed', 'mouseReleased']
    }
    expect(await targetListingsForClicks(100, click)).toEqual({ listings: 10, records: 0 })
    expect(await targetListingsForClicks(1_000, click)).toEqual({ listings: 10, records: 0 })
  })

  // An in-process frame's owner (its border) is missing from the list; one fresh listing settles it.
  it('lists targets once for a press on a frame that is not cross-site', async () => {
    const press = {
      clicks: 10,
      hit: { nodeName: 'IFRAME', frameId: 'local' },
      types: ['mousePressed', 'mouseReleased']
    }
    expect(await targetListingsForClicks(100, press)).toEqual({ listings: 10, records: 0 })
    expect(await targetListingsForClicks(1_000, press)).toEqual({ listings: 10, records: 0 })
  })

  // The move's own list answers for the frame even when the page's probes outlast its lifetime.
  it('lists targets once per move over a cross-site frame on a slow page', async () => {
    const moves = {
      clicks: 10,
      hit: { nodeName: 'IFRAME', frameId: CROSS_SITE_FRAME.targetId },
      probeMs: 400,
      types: ['mouseMoved']
    }
    expect(await targetListingsForClicks(100, moves)).toEqual({ listings: 10, records: 10 })
    expect(await targetListingsForClicks(1_000, moves)).toEqual({ listings: 10, records: 10 })
  })
})
