import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  encodeBrowserScreencastFrame
} from '../../../../shared/browser-screencast-protocol'
import { acknowledgeBrowserScreencastFrame } from './browser-screencast-frame-credit'
import {
  createSinglePageBrowserCommandsHost,
  createStreamedGuest
} from '../client-pages/single-page-browser-commands-host-test-double'

const { webContentsFromId, startBrowserScreencast } = vi.hoisted(() => ({
  webContentsFromId: vi.fn(),
  startBrowserScreencast: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: webContentsFromId }
}))
vi.mock('../../../browser/cdp/screencast/browser-screencast-stream', () => ({
  startBrowserScreencast
}))

const PHONE = 'phone-1'

function frame(seq: number): Uint8Array {
  return encodeBrowserScreencastFrame({
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format: 'jpeg',
    metadata: {},
    image: new Uint8Array([seq])
  })
}

async function subscribe(frameAck: boolean) {
  const { RuntimeBrowserCommands } = await import('../commands/browser-commands')
  startBrowserScreencast.mockResolvedValue({
    stop: vi.fn(),
    done: new Promise<void>(() => {}),
    updateViewport: vi.fn(async () => {})
  })
  const sent: number[] = []
  const sentAt: number[] = []
  const commands = new RuntimeBrowserCommands(createSinglePageBrowserCommandsHost())
  const subscription = await commands.browserScreencast(
    { worktree: 'id:wt-1', page: 'page-1', format: 'jpeg', ...(frameAck ? { frameAck: 1 } : {}) },
    {
      pairedDeviceId: PHONE,
      sendBinary: (bytes) => {
        sent.push(decodeBrowserScreencastFrame(bytes)!.seq)
        sentAt.push(Date.now())
        return true
      }
    }
  )
  const onFrame: (bytes: Uint8Array) => unknown = startBrowserScreencast.mock.calls[0][1].onFrame
  const ack = (seq: number, device = PHONE) =>
    acknowledgeBrowserScreencastFrame(subscription.subscriptionId, device, seq)
  return { subscription, onFrame, sent, sentAt, ack }
}

describe('screencast frame credit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    webContentsFromId.mockReset()
    webContentsFromId.mockReturnValue(createStreamedGuest())
    startBrowserScreencast.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends every frame and echoes nothing when the viewer does not ask for credit', async () => {
    const { subscription, onFrame, sent } = await subscribe(false)
    for (let seq = 0; seq < 5; seq++) {
      onFrame(frame(seq))
    }
    expect(subscription.ready.frameAck).toBeUndefined()
    expect(sent).toEqual([0, 1, 2, 3, 4])
    subscription.session.stop()
  })

  it('holds the newest frame while two are unacked and sends it on a cumulative ack', async () => {
    const { subscription, onFrame, sent, ack } = await subscribe(true)
    expect(subscription.ready.frameAck).toBe(true)
    for (let seq = 0; seq < 4; seq++) {
      onFrame(frame(seq))
    }
    expect(sent).toEqual([0, 1])

    expect(ack(1, 'other-phone')).toBe(false)
    expect(sent).toEqual([0, 1])

    expect(ack(1)).toBe(true)
    expect(sent).toEqual([0, 1, 3])
    subscription.session.stop()
  })

  // #25263: a fixed two-frame window delivered about a third of 10 fps on an idle 600 ms link.
  it('keeps 10 fps on an uncongested 600 ms round trip', async () => {
    const { subscription, onFrame, sent, sentAt, ack } = await subscribe(true)
    let acked = 0
    for (let tick = 0; tick < 100; tick++) {
      onFrame(frame(tick))
      for (let step = 0; step < 10; step++) {
        await vi.advanceTimersByTimeAsync(10)
        // Each frame's ack lands 600 ms after it went out.
        while (acked < sent.length && sentAt[acked]! + 600 <= Date.now()) {
          ack(sent[acked]!)
          acked += 1
        }
      }
    }
    // Only frames 2–4 are skipped, superseded while the first ack is still in flight.
    expect(sent).toEqual([0, 1, ...Array.from({ length: 95 }, (_, index) => index + 5)])
    subscription.session.stop()
  })

  // #25263: a 2 s expiry let ten unacked frames through in 10 s. Probes back off to one per 8 s.
  it('sends one probe frame per backed-off stall when no ack ever comes', async () => {
    const { subscription, onFrame, sent } = await subscribe(true)
    for (let tick = 0; tick < 300; tick++) {
      onFrame(frame(tick))
      await vi.advanceTimersByTimeAsync(100)
    }
    // The base window, then probes 2 s, 4 s, 8 s and 8 s after each hold (t = 2.2, 6.2, 14.2, 22.2 s).
    expect(sent).toEqual([0, 1, 21, 61, 141, 221])
    subscription.session.stop()
  })
})
