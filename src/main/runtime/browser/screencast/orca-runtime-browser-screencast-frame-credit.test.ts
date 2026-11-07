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
})
