import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'

const request: RpcRequest = {
  id: 'req-output-race',
  authToken: 'tok',
  method: 'terminal.subscribe',
  params: {
    terminal: 'terminal-output-race',
    client: { id: 'phone-output-race', type: 'mobile' },
    capabilities: { terminalBinaryStream: 1 }
  }
}

describe('terminal subscribe renderer recovery output ordering', () => {
  it('replays bytes absent from the renderer snapshot using its exact sequence boundary', async () => {
    const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
    const cleanups = new Map<string, () => void>()
    let outputSequence = 0
    let rendererSerializeCalls = 0
    let onData:
      | ((data: string, meta?: { seq?: number; rawLength?: number; cwd?: string }) => void)
      | undefined
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      resolveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-output-race' }),
      hasHeadlessTerminalState: vi.fn(() => false),
      requestRendererTerminalTabMount: vi.fn(() => true),
      getRendererTerminalSerializerGenerationForHandle: vi.fn(() => 1),
      getRendererTerminalSerializerGeneration: vi.fn(() => 1),
      waitForRendererTerminalSerializer: vi.fn().mockResolvedValue(true),
      getPtyOutputSequence: vi.fn(() => outputSequence),
      handleMobileSubscribe: vi.fn().mockResolvedValue(true),
      handleMobileUnsubscribe: vi.fn(),
      subscribeToTerminalData: vi.fn((_ptyId, listener) => {
        onData = listener
        return vi.fn()
      }),
      registerRemoteTerminalViewSubscriber: vi.fn(() => vi.fn()),
      readTerminal: vi.fn().mockResolvedValue({ tail: [], truncated: false }),
      serializeTerminalBuffer: vi.fn().mockResolvedValue(null),
      serializeRendererTerminalBuffer: vi.fn(async () => {
        rendererSerializeCalls += 1
        if (rendererSerializeCalls === 1) {
          outputSequence = 6
          onData?.('during', { seq: 6, rawLength: 6 })
          return { data: 'stale renderer', cols: 80, rows: 24 }
        }
        return { data: 'restored history', cols: 80, rows: 24, seq: 0 }
      }),
      replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn(() => {
        outputSequence = 11
        onData?.('after', { seq: 11, rawLength: 5 })
      }),
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
      connectionId: 'conn-phone',
      sendBinary: (bytes) => {
        binaryFrames.push(bytes)
      },
      registerBinaryStreamHandler: vi.fn(() => vi.fn())
    })

    await vi.waitFor(() => {
      const output = binaryFrames
        .map((bytes) => decodeTerminalStreamFrame(bytes))
        .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
        .map((frame) => decodeTerminalStreamText(frame!.payload))
        .join('')
      expect(output).toBe('duringafter')
    })

    const snapshot = binaryFrames
      .map((bytes) => decodeTerminalStreamFrame(bytes))
      .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
      .map((frame) => decodeTerminalStreamText(frame!.payload))
      .join('')
    expect(snapshot).toBe('restored history')
    expect(rendererSerializeCalls).toBe(2)

    runtime.cleanupSubscription('terminal-output-race:phone-output-race')
    await dispatchPromise
  })
})
