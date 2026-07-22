import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const makeRequest = (method: string, params?: unknown): RpcRequest => ({
  id: 'req-1',
  authToken: 'tok',
  method,
  params
})

describe('terminal transformed residual replay', () => {
  it('preserves sparse output metadata after snapshot boundary trimming', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let dataListener:
      | ((data: string, meta?: { seq?: number; rawLength?: number; transformed?: boolean }) => void)
      | undefined
    let resolveMobileSubscribe: () => void = () => {}
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      handleMobileSubscribe: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            resolveMobileSubscribe = () => resolve(true)
          })
      ),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        dataListener = listener
        return vi.fn()
      }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      requestRendererTerminalTabMount: vi.fn().mockReturnValue(false),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi
        .fn()
        .mockResolvedValue({ data: 'snapshot', cols: 80, rows: 24, seq: 4 }),
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
      // 为什么：此用例只实现 terminal.subscribe 触及的 runtime 表面，避免构造无关方法。
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

    const dispatchPromise = dispatcher.dispatchStreaming(
      makeRequest('terminal.subscribe', {
        terminal: 'terminal-1',
        client: { id: 'phone-1', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      }),
      vi.fn(),
      {
        connectionId: 'conn-phone',
        sendBinary: (bytes) => {
          binaryFrames.push(bytes)
        },
        registerBinaryStreamHandler: vi.fn(() => vi.fn())
      }
    )

    await vi.waitFor(() => expect(runtime.handleMobileSubscribe).toHaveBeenCalled())
    expect(dataListener).toBeDefined()
    dataListener?.('abcdef', { seq: 11, rawLength: 9, transformed: true })
    resolveMobileSubscribe()

    await vi.waitFor(() =>
      expect(
        binaryFrames.some(
          (bytes) => decodeTerminalStreamFrame(bytes)?.opcode === TerminalStreamOpcode.OutputSpan
        )
      ).toBe(true)
    )
    const outputSpan = binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .find((frame) => frame?.opcode === TerminalStreamOpcode.OutputSpan)

    expect(outputSpan?.seq).toBe(11)
    expect(outputSpan && decodeTerminalStreamJson(outputSpan.payload)).toEqual({
      data: 'cdef',
      rawLength: 9,
      transformed: true
    })

    runtime.cleanupSubscription('terminal-1:phone-1')
    await dispatchPromise
  })
})
