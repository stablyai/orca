import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import type { OrcaRuntimeService } from '../orca-runtime'
import { TERMINAL_METHODS } from './methods/terminal'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame
} from '../../../shared/terminal-stream-protocol'

function stubRuntime(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    requestRendererTerminalTabMount: () => false,
    ...overrides
  } as OrcaRuntimeService
}

const makeRequest = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

describe('terminal subscribe unknown-screen restream', () => {
  it('does not restream scrollback when the screen kind is unknown', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let resizeListener:
      | ((event: {
          cols: number
          rows: number
          displayMode: string
          reason: string
          seq: number
        }) => void)
      | undefined
    const serializeTerminalBuffer = vi.fn().mockResolvedValue({
      data: 'initial',
      cols: 80,
      rows: 24
    })
    const runtime = stubRuntime({
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer,
      getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
      getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
      getLayout: vi.fn().mockReturnValue({ seq: 1 }),
      getTerminalScreenKind: vi.fn().mockReturnValue('unknown'),
      isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
      handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
      subscribeToTerminalResize: vi.fn((_, listener) => {
        resizeListener = listener as typeof resizeListener
        return vi.fn()
      }),
      subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
      registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
        cleanups.set(id, cleanup)
      }),
      cleanupSubscription: vi.fn((id: string) => {
        const cleanup = cleanups.get(id)
        cleanups.delete(id)
        cleanup?.()
      }),
      waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {})),
      sendTerminal: vi.fn().mockResolvedValue({ accepted: true }),
      updateMobileViewport: vi.fn().mockResolvedValue({ updated: true, applied: true })
    })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: TERMINAL_METHODS
    })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      () => {},
      {
        connectionId: 'conn-unknown-screen',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        }
      }
    )

    await vi.waitFor(() => expect(resizeListener).toBeDefined())
    serializeTerminalBuffer.mockClear()
    binaryFrames.splice(0)

    resizeListener?.({
      cols: 90,
      rows: 24,
      displayMode: 'auto',
      reason: 'apply-layout',
      seq: 2
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(serializeTerminalBuffer).not.toHaveBeenCalled()
    const opcodes = binaryFrames
      .map((frame) => decodeTerminalStreamFrame(frame)?.opcode)
      .filter((opcode) => opcode != null)
    expect(opcodes).toContain(TerminalStreamOpcode.Resized)
    expect(opcodes).not.toContain(TerminalStreamOpcode.SnapshotStart)

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })
})
