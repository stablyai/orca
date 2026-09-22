import { describe, expect, it, vi } from 'vitest'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../../../../shared/terminal-stream-protocol'
import { registerLegacyBinaryControlFrames } from './terminal-legacy-binary-control-frames'
import { installMultiplexSlotFrames } from './terminal-multiplex-slot-frames'

const INPUT_FRAME: TerminalStreamFrame = {
  opcode: TerminalStreamOpcode.Input,
  streamId: 1,
  seq: 1,
  payload: encodeTerminalStreamText('ls\r')
}

function makeRuntime() {
  return {
    getDriver: vi.fn(() => ({ kind: 'desktop' })),
    sendTerminal: vi.fn(
      async (_handle: string, _action: unknown, _options?: Record<string, unknown>) => ({
        accepted: true,
        bytesWritten: 3
      })
    )
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('terminal stream Input frames carry the connection identity into the write', () => {
  it('terminal.multiplex uses the paired device the connection was opened with', async () => {
    const runtime = makeRuntime()
    const stream = {
      streamId: 1,
      terminal: 'term-1',
      ptyId: 'pty-1',
      client: { id: 'desktop-1', type: 'desktop' },
      isMobile: false,
      desktopClaimTail: Promise.resolve(true)
    }
    const state = {
      runtime,
      closed: false,
      streams: new Map([[1, stream]]),
      pairedDeviceId: 'device-laptop',
      clientKind: 'runtime',
      notifyStreamWriteUnavailable: vi.fn()
    } as never
    installMultiplexSlotFrames(state)

    ;(state as { handleSlotFrame: (s: unknown, f: TerminalStreamFrame) => void }).handleSlotFrame(
      stream,
      INPUT_FRAME
    )
    await settle()

    expect(runtime.sendTerminal).toHaveBeenCalledWith('term-1', expect.anything(), {
      inputSource: { pairedDeviceId: 'device-laptop', clientKind: 'runtime' }
    })
  })

  it('legacy terminal.subscribe uses the paired device from the subscription context', async () => {
    const runtime = makeRuntime()
    let handler: ((frame: TerminalStreamFrame) => void) | null = null
    registerLegacyBinaryControlFrames(
      {
        params: { terminal: 'term-1', client: { id: 'phone-1', type: 'mobile' } },
        runtime,
        registerBinaryStreamHandler: (_streamId: number, next: typeof handler) => {
          handler = next
          return () => {}
        },
        ptyId: 'pty-1',
        clientId: 'phone-1',
        pairedDeviceId: 'device-phone',
        clientKind: 'mobile',
        isMobile: true,
        supportsDesktopViewportClaims: false,
        supportsWriteUnavailable: false
      } as never,
      1,
      'remote-desktop',
      {
        isClosed: () => false,
        isBuffering: () => false,
        setRegisteredRemoteDesktopDriver: vi.fn(),
        setPendingRemoteDesktopViewport: vi.fn(),
        getDesktopClaimTail: () => Promise.resolve(true),
        setDesktopClaimTail: vi.fn(),
        sendFrame: vi.fn()
      }
    )

    handler!(INPUT_FRAME)
    await settle()

    expect(runtime.sendTerminal).toHaveBeenCalledTimes(1)
    expect(runtime.sendTerminal.mock.calls[0]?.[2]).toMatchObject({
      inputSource: { pairedDeviceId: 'device-phone', clientKind: 'mobile' }
    })
  })
})
