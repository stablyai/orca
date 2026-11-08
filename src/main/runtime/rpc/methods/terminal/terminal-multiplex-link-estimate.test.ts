import { describe, expect, it } from 'vitest'
import { TerminalMultiplexLinkEstimate } from './terminal-multiplex-link-estimate'
import type { TerminalMultiplexStream } from './terminal-stream-types'

type LinkShape = {
  bytesPerMs: number
  returnMs: number
  frameBytes: number
  queuedFrames?: number
}

// A FIFO link that keeps frames queued (four by default), so every sample after the first is window-limited.
function createFloodedLink() {
  const clock = { now: 0 }
  const estimate = new TerminalMultiplexLinkEstimate(() => clock.now, true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the estimate only keys its ledger by stream identity.
  const stream = {} as TerminalMultiplexStream
  const inFlight: { ackAt: number; bytes: number }[] = []
  let linkFreeAt = 0
  const send = (link: LinkShape, paced: boolean): void => {
    estimate.noteSent(stream, link.frameBytes, {
      backlogged: true,
      paced,
      connectionInFlightBytes: inFlight.reduce((total, frame) => total + frame.bytes, 0)
    })
    linkFreeAt = Math.max(linkFreeAt, clock.now) + link.frameBytes / link.bytesPerMs
    inFlight.push({ ackAt: linkFreeAt + link.returnMs, bytes: link.frameBytes })
  }
  const flood = (link: LinkShape, acks: number, paced = false): void => {
    while (inFlight.length < (link.queuedFrames ?? 4)) {
      send(link, paced)
    }
    for (let i = 0; i < acks; i += 1) {
      const ack = inFlight.shift()!
      clock.now = Math.max(clock.now, ack.ackAt)
      estimate.noteAcknowledged(stream, ack.bytes)
      send(link, paced)
    }
  }
  // A recovery image takes link time but is never acked.
  const sendImage = (link: LinkShape, bytes: number): void => {
    estimate.noteImageSent(bytes)
    linkFreeAt = Math.max(linkFreeAt, clock.now) + bytes / link.bytesPerMs
  }
  return { estimate, flood, sendImage }
}

const SLOW_LINK = { bytesPerMs: 125, returnMs: 100, frameBytes: 16 * 1024 }

describe('TerminalMultiplexLinkEstimate', () => {
  it('sizes a slow high-latency link near twice its bandwidth-delay product', () => {
    const { estimate, flood } = createFloodedLink()
    flood(SLOW_LINK, 20)
    const window = estimate.pacedWindowBytes()
    expect(window).toBeGreaterThanOrEqual(64 * 1024)
    expect(window).toBeLessThanOrEqual(160 * 1024)
  })

  it('never paces a LAN, even when its client parses slowly', () => {
    const { estimate, flood } = createFloodedLink()
    flood({ bytesPerMs: 500, returnMs: 1, frameBytes: 8 * 1024 }, 40)
    expect(estimate.pacedWindowBytes()).toBeNull()
  })

  it('never paces a fast link', () => {
    const { estimate, flood } = createFloodedLink()
    flood({ bytesPerMs: 8_000, returnMs: 100, frameBytes: 48 * 1024, queuedFrames: 40 }, 80)
    expect(estimate.pacedWindowBytes()).toBeNull()
  })

  it('returns to legacy windows when the path RTT jumps', () => {
    const { estimate, flood } = createFloodedLink()
    flood(SLOW_LINK, 20, true)
    expect(estimate.pacedWindowBytes()).not.toBeNull()
    flood({ ...SLOW_LINK, returnMs: 3_000 }, 12, true)
    expect(estimate.pacedWindowBytes()).toBeNull()
  })

  it('keeps pacing while recovery images share the link', () => {
    const { estimate, flood, sendImage } = createFloodedLink()
    flood(SLOW_LINK, 20, true)
    expect(estimate.pacedWindowBytes()).not.toBeNull()
    for (let i = 0; i < 10; i += 1) {
      sendImage(SLOW_LINK, 96 * 1024)
      flood(SLOW_LINK, 4, true)
    }
    expect(estimate.pacedWindowBytes()).not.toBeNull()
  })
})
