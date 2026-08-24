import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
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

function inputFrame(streamId: number, seq = 2, text = 'input') {
  return decodeTerminalStreamFrame(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      streamId,
      seq,
      payload: encodeTerminalStreamText(text)
    })
  )!
}

describe('desktop input claim serialization', () => {
  it('multiplex revalidates runtime ownership before remote input bytes', async () => {
    let owner = 'host'
    let releaseClaim = (): void => {}
    const order: string[] = []
    const claimRemoteDesktopViewer = vi.fn(
      (_ptyId: string, subscriptionKey: string) =>
        new Promise<boolean>((resolve) => {
          releaseClaim = () => {
            owner = subscriptionKey
            order.push(`claim:${subscriptionKey}`)
            resolve(true)
          }
        })
    )
    const sendTerminal = vi.fn().mockImplementation(async () => {
      order.push(`input:${owner}`)
      return { accepted: true }
    })
    const harness = startDesktopMultiplexSubscribe({ claimRemoteDesktopViewer, sendTerminal })

    sendDesktopMultiplexSubscribe(harness.handlers)
    await vi.waitFor(() =>
      expect(
        harness.messages.some((message) => JSON.parse(message).result?.type === 'subscribed')
      ).toBe(true)
    )
    harness.handlers.get(7)!(inputFrame(7))

    await vi.waitFor(() => expect(claimRemoteDesktopViewer).toHaveBeenCalledTimes(1))
    expect(sendTerminal).not.toHaveBeenCalled()
    expect(owner).toBe('host')

    releaseClaim()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    expect(order).toEqual([
      'claim:multiplex:conn-desktop-first-paint:7',
      'input:multiplex:conn-desktop-first-paint:7'
    ])

    claimRemoteDesktopViewer.mockClear()
    sendTerminal.mockClear()
    harness.handlers.get(7)!(inputFrame(7, 3, '\u001b[O\u001b[I'))
    await Promise.resolve()
    expect(claimRemoteDesktopViewer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    sendTerminal.mockClear()
    harness.handlers.get(7)!(inputFrame(7, 4, '\u001b[3;1R'))
    await Promise.resolve()
    expect(claimRemoteDesktopViewer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))

    harness.runtime.cleanupSubscription('terminal-multiplex:conn-desktop-first-paint')
    await harness.dispatchPromise
  })

  it('single stream revalidates runtime ownership before remote input bytes', async () => {
    let owner = 'host'
    let releaseClaim = (): void => {}
    const order: string[] = []
    const handlers = new Map<
      number,
      (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
    >()
    const registry = createSubscriptionRegistryDouble()
    const claimRemoteDesktopViewer = vi.fn(
      (_ptyId: string, subscriptionKey: string) =>
        new Promise<boolean>((resolve) => {
          releaseClaim = () => {
            owner = subscriptionKey
            order.push(`claim:${subscriptionKey}`)
            resolve(true)
          }
        })
    )
    const sendTerminal = vi.fn().mockImplementation(async () => {
      order.push(`input:${owner}`)
      return { accepted: true }
    })
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue({ data: 'snapshot', cols: 120, rows: 40 }),
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
      claimRemoteDesktopViewer,
      sendTerminal
    })
    const messages: string[] = []
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'desktop-1', type: 'desktop' },
        viewport: { cols: 120, rows: 40 },
        capabilities: { terminalBinaryStream: 1, ackOutput: 1, desktopViewportClaims: 1 }
      }),
      (message) => messages.push(message),
      {
        connectionId: 'conn-single-input',
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
    handler(inputFrame(streamId))

    await vi.waitFor(() => expect(claimRemoteDesktopViewer).toHaveBeenCalledTimes(1))
    expect(sendTerminal).not.toHaveBeenCalled()
    expect(owner).toBe('host')

    releaseClaim()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['claim:stream:1', 'input:stream:1'])

    claimRemoteDesktopViewer.mockClear()
    sendTerminal.mockClear()
    handler(inputFrame(streamId, 3, '\u001b[O\u001b[I'))
    await Promise.resolve()
    expect(claimRemoteDesktopViewer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))
    sendTerminal.mockClear()
    handler(inputFrame(streamId, 4, '\u001b[3;1R'))
    await Promise.resolve()
    expect(claimRemoteDesktopViewer).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(sendTerminal).toHaveBeenCalledTimes(1))

    runtime.cleanupSubscription('terminal-1:desktop-1')
    await dispatchPromise
  })
})
