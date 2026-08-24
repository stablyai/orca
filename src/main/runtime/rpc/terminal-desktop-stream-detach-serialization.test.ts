import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import {
  makeRequest,
  sendDesktopMultiplexSubscribe,
  startDesktopMultiplexSubscribe,
  stubRuntime
} from './terminal-multiplex-test-harness'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

const CLIENT_CASES: {
  name: string
  capabilities: Record<string, 1>
  opcode: TerminalStreamOpcode
}[] = [
  {
    name: 'current client claims',
    capabilities: { ackOutput: 1 as const, desktopViewportClaims: 1 as const },
    opcode: TerminalStreamOpcode.ClaimViewport
  },
  {
    name: 'legacy client resize claims',
    capabilities: { ackOutput: 1 as const },
    opcode: TerminalStreamOpcode.Resize
  }
]

const MULTIPLEX_CASES = CLIENT_CASES.flatMap((client) =>
  (['slot unsubscribe', 'connection cleanup'] as const).map((detach) => ({ ...client, detach }))
)

function encodedFrame(
  opcode: TerminalStreamOpcode,
  streamId: number,
  seq: number,
  payload: Uint8Array<ArrayBufferLike>
) {
  return decodeTerminalStreamFrame(encodeTerminalStreamFrame({ opcode, streamId, seq, payload }))!
}

async function flushPromiseChain(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('desktop viewport stream detach serialization', () => {
  it.each(MULTIPLEX_CASES)(
    'multiplex $detach drops queued $name and input before detach restoration',
    async ({ capabilities, detach, opcode }) => {
      let owner = 'host'
      let releaseClaim = (): void => {}
      const updateRemoteDesktopViewer = vi.fn(
        async (_ptyId: string, subscriptionKey: string): Promise<boolean> => {
          owner = subscriptionKey
          return true
        }
      )
      const unregisterRemoteDesktopViewer = vi.fn(
        async (_ptyId: string, _subscriptionKey: string): Promise<boolean> => {
          owner = 'host'
          return true
        }
      )
      const unregisterRemoteDesktopViewers = vi.fn(
        async (_ptyId: string, _subscriptionKeys: Iterable<string>): Promise<boolean> => {
          owner = 'host'
          return true
        }
      )
      const harness = startDesktopMultiplexSubscribe({
        updateRemoteDesktopViewer,
        unregisterRemoteDesktopViewer,
        unregisterRemoteDesktopViewers,
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
      })

      sendDesktopMultiplexSubscribe(harness.handlers, capabilities)
      await vi.waitFor(() =>
        expect(
          harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
        ).toBe(true)
      )
      owner = 'host'
      updateRemoteDesktopViewer.mockImplementationOnce(
        (_ptyId: string, subscriptionKey: string) => {
          owner = subscriptionKey
          return new Promise<boolean>((resolve) => {
            releaseClaim = () => resolve(true)
          })
        }
      )

      const handler = harness.handlers.get(7)!
      handler(encodedFrame(opcode, 7, 2, encodeTerminalStreamJson({ cols: 96, rows: 32 })))
      await vi.waitFor(() => expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(2))
      handler(encodedFrame(opcode, 7, 3, encodeTerminalStreamJson({ cols: 88, rows: 28 })))
      handler(encodedFrame(TerminalStreamOpcode.Input, 7, 4, encodeTerminalStreamText('late')))
      if (detach === 'slot unsubscribe') {
        handler(encodedFrame(TerminalStreamOpcode.Unsubscribe, 7, 5, new Uint8Array()))
      } else {
        harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      }

      if (detach === 'slot unsubscribe') {
        expect(unregisterRemoteDesktopViewer).toHaveBeenCalledWith(
          'pty-1',
          'multiplex:conn-desktop-first-paint:7'
        )
      } else {
        expect(unregisterRemoteDesktopViewers).toHaveBeenCalledWith('pty-1', [
          'multiplex:conn-desktop-first-paint:7'
        ])
      }
      expect(owner).toBe('host')
      releaseClaim()
      await flushPromiseChain()

      expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(2)
      expect(harness.runtime.sendTerminal).not.toHaveBeenCalled()
      expect(owner).toBe('host')

      if (detach === 'slot unsubscribe') {
        harness.registry.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
      }
      await harness.dispatchPromise
    }
  )

  it.each(CLIENT_CASES)(
    'single stream drops queued $name and input before detach restoration',
    async ({ capabilities, opcode }) => {
      let owner = 'host'
      let releaseClaim = (): void => {}
      const handlers = new Map<
        number,
        (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      >()
      const registry = createSubscriptionRegistryDouble()
      const updateRemoteDesktopViewer = vi.fn(
        async (_ptyId: string, subscriptionKey: string): Promise<boolean> => {
          owner = subscriptionKey
          return true
        }
      )
      const unregisterRemoteDesktopViewer = vi.fn(
        async (_ptyId: string, _subscriptionKey: string): Promise<boolean> => {
          owner = 'host'
          return true
        }
      )
      const runtime = stubRuntime({
        resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
        readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
        serializeTerminalBuffer: vi
          .fn()
          .mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
        getTerminalSize: vi.fn().mockReturnValue({ cols: 120, rows: 40 }),
        getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
        getLayout: vi.fn().mockReturnValue({ seq: 1 }),
        subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
        subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
        subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
        getTerminalFitOverride: vi.fn().mockReturnValue(null),
        getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
        registerOwnedSubscriptionCleanup: vi.fn(registry.registerOwnedSubscriptionCleanup),
        cleanupSubscription: vi.fn(registry.cleanupSubscription),
        waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
        updateRemoteDesktopViewer,
        unregisterRemoteDesktopViewer,
        sendTerminal: vi.fn().mockResolvedValue({ accepted: true })
      })
      const messages: string[] = []
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
      const dispatchPromise = dispatcher.dispatchStreaming(
        makeRequest('terminal.subscribe', {
          terminal: 'terminal-1',
          client: { id: 'desktop-1', type: 'desktop' },
          viewport: { cols: 120, rows: 40 },
          capabilities: { terminalBinaryStream: 1, ...capabilities }
        }),
        (message) => messages.push(message),
        {
          connectionId: 'conn-single',
          sendBinary: vi.fn(),
          registerBinaryStreamHandler: (streamId, handler) => {
            handlers.set(streamId, handler)
            return () => handlers.delete(streamId)
          }
        }
      )

      await vi.waitFor(() =>
        expect(messages.some((message) => JSON.parse(message).result?.type === 'subscribed')).toBe(
          true
        )
      )
      const [streamId, handler] = Array.from(handlers.entries())[0]!
      owner = 'host'
      updateRemoteDesktopViewer.mockImplementationOnce(
        (_ptyId: string, subscriptionKey: string) => {
          owner = subscriptionKey
          return new Promise<boolean>((resolve) => {
            releaseClaim = () => resolve(true)
          })
        }
      )

      handler(encodedFrame(opcode, streamId, 2, encodeTerminalStreamJson({ cols: 96, rows: 32 })))
      await vi.waitFor(() => expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(2))
      handler(encodedFrame(opcode, streamId, 3, encodeTerminalStreamJson({ cols: 88, rows: 28 })))
      handler(
        encodedFrame(TerminalStreamOpcode.Input, streamId, 4, encodeTerminalStreamText('late'))
      )
      runtime.cleanupSubscription('terminal-1:desktop-1')

      expect(unregisterRemoteDesktopViewer).toHaveBeenCalledWith('pty-1', expect.any(String))
      expect(owner).toBe('host')
      releaseClaim()
      await flushPromiseChain()

      expect(updateRemoteDesktopViewer).toHaveBeenCalledTimes(2)
      expect(runtime.sendTerminal).not.toHaveBeenCalled()
      expect(owner).toBe('host')
      await dispatchPromise
    }
  )
})
