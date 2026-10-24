import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { connect } from '../transport/rpc-client'
import { useMobileSessionTerminalInput } from './use-mobile-session-terminal-input'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock(
  '../transport/direct-e2ee-framing-policy',
  () => import('../transport/legacy-direct-framing-test-policy')
)

vi.mock('../transport/e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

vi.mock('../transport/mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.receive(JSON.stringify({ type: 'e2ee_ready' }))
    this.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []

describe('terminal Clear transport delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not replay a terminal Clear after the connection drops before delivery', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const showToast = vi.fn()
    const subscribeToTerminal = vi.fn()
    let clearHost: (() => Promise<void>) | undefined
    function Harness() {
      const actions = useMobileSessionTerminalInput(
        mountFixture<Parameters<typeof useMobileSessionTerminalInput>[0]>({
          client,
          clientRef: { current: client },
          showToast,
          getTerminalRef: () => undefined,
          unsubscribeTerminal: vi.fn(),
          subscribeToTerminal
        })
      )
      clearHost = () =>
        actions.handleClearTerminal({ handle: 't1', title: 'Shell', isActive: true })
      return null
    }
    let tree: ReturnType<typeof create> | undefined
    act(() => {
      tree = create(createElement(Harness))
    })
    socket.close()
    try {
      const pending = clearHost?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(showToast.mock.calls).toEqual([["Couldn't clear terminal", 1500]])
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(
        mockSockets[1]!.sent.filter((frame) => frame.includes('terminal.clearBuffer'))
      ).toEqual([])
      expect(subscribeToTerminal).not.toHaveBeenCalled()
      await pending
    } finally {
      act(() => tree?.unmount())
      client.close()
    }
  })
})
