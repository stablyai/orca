import { expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import type { RpcRequest } from './core'
import { TERMINAL_METHODS } from './methods/terminal'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'

const request: RpcRequest = {
  id: 'req-provider-sequence',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-restored',
    client: { id: 'phone-1', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

it('replays post-capture output in the provider snapshot sequence domain', async () => {
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const cleanups = new Map<string, () => void>()
  let dataListener:
    | ((data: string, meta?: { seq?: number; rawLength?: number }) => void)
    | undefined
  let resolveSnapshot:
    | ((snapshot: { data: string; cols: number; rows: number; seq: number }) => void)
    | undefined
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-restored' }),
    handleMobileSubscribe: vi.fn().mockResolvedValue(true),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn((_ptyId, listener) => {
      dataListener = listener
      return vi.fn()
    }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer: vi.fn(
      () =>
        new Promise<{ data: string; cols: number; rows: number; seq: number }>((resolve) => {
          resolveSnapshot = resolve
        })
    ),
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(false),
    subscribeToTerminalResize: vi.fn().mockReturnValue(vi.fn()),
    subscribeToFitOverrideChanges: vi.fn().mockReturnValue(vi.fn()),
    registerSubscriptionCleanup: vi.fn((id: string, cleanup: () => void) => {
      cleanups.set(id, cleanup)
    }),
    cleanupSubscription: vi.fn((id: string) => {
      cleanups.get(id)?.()
      cleanups.delete(id)
    }),
    waitForTerminal: vi.fn(() => new Promise<RuntimeTerminalWait>(() => {}))
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

  const dispatchPromise = dispatcher.dispatchStreaming(request, vi.fn(), {
    connectionId: 'conn-restored',
    sendBinary: (bytes) => {
      binaryFrames.push(bytes)
    }
  })

  await vi.waitFor(() => expect(resolveSnapshot).toBeDefined())
  resolveSnapshot?.({ data: 'restored snapshot', cols: 80, rows: 24, seq: 900 })
  // Why: provider attach anchoring makes this first new chunk continue at
  // 905 instead of restarting at 5, so snapshot reconciliation keeps it.
  dataListener?.('fresh', { seq: 905, rawLength: 5 })

  await vi.waitFor(() =>
    expect(
      binaryFrames.some((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes)
        return (
          frame?.opcode === TerminalStreamOpcode.Output &&
          decodeTerminalStreamText(frame.payload) === 'fresh'
        )
      })
    ).toBe(true)
  )

  runtime.cleanupSubscription('terminal-restored:phone-1')
  await dispatchPromise
})

it('keeps provider-backed alternate-screen resizes geometry-only', async () => {
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
  const serializeTerminalBuffer = vi
    .fn()
    .mockResolvedValue({ data: 'restored tui', cols: 80, rows: 24 })
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    registerRemoteTerminalViewSubscriber: () => () => {},
    resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-tui' }),
    readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
    serializeTerminalBuffer,
    getTerminalSize: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    getMobileDisplayMode: vi.fn().mockReturnValue('auto'),
    getLayout: vi.fn().mockReturnValue({ seq: 1 }),
    isTerminalAlternateScreen: vi.fn().mockReturnValue(true),
    handleMobileSubscribe: vi.fn().mockResolvedValue(undefined),
    handleMobileUnsubscribe: vi.fn(),
    subscribeToTerminalData: vi.fn().mockReturnValue(vi.fn()),
    subscribeToTerminalResize: vi.fn((_ptyId, listener) => {
      resizeListener = listener
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
  } as unknown as OrcaRuntimeService
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const dispatchPromise = dispatcher.dispatchStreaming(
    {
      ...request,
      id: 'req-provider-alt-screen',
      params: {
        terminal: 'terminal-tui',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }
    },
    vi.fn(),
    {
      connectionId: 'conn-tui-resize',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      }
    }
  )

  await vi.waitFor(() => expect(resizeListener).toBeDefined())
  binaryFrames.splice(0)
  resizeListener?.({
    cols: 100,
    rows: 30,
    displayMode: 'auto',
    reason: 'apply-layout',
    seq: 2
  })
  await vi.waitFor(() =>
    expect(
      binaryFrames.some(
        (frame) => decodeTerminalStreamFrame(frame)?.opcode === TerminalStreamOpcode.Resized
      )
    ).toBe(true)
  )

  expect(serializeTerminalBuffer).toHaveBeenCalledOnce()
  expect(
    binaryFrames.some(
      (frame) => decodeTerminalStreamFrame(frame)?.opcode === TerminalStreamOpcode.SnapshotStart
    )
  ).toBe(false)

  runtime.cleanupSubscription('terminal-tui:phone-1')
  await dispatchPromise
})
