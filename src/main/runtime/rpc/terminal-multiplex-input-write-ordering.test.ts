import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { installMultiplexSlotFrames } from './methods/terminal/terminal-multiplex-slot-frames'
import type { TerminalMultiplexCleanupStage } from './methods/terminal/terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './methods/terminal/terminal-stream-types'
import {
  TerminalStreamOpcode,
  encodeTerminalStreamText
} from '../../../shared/terminal-stream-protocol'
import type { OrcaRuntimeService } from '../orca-runtime'

describe('terminal multiplex input ordering', () => {
  it('writes an earlier stream frame before a later Quick Command RPC', async () => {
    const writes: string[] = []
    let releaseClaim: (claimed: boolean) => void = () => {}
    const desktopClaim = new Promise<boolean>((resolve) => {
      releaseClaim = resolve
    })
    let writeTail = Promise.resolve()
    const enqueueTerminalInputWrite = vi.fn(
      async <T>(_ptyId: string, write: () => Promise<T>): Promise<T> => {
        const current = writeTail.then(write)
        writeTail = current.then(
          () => undefined,
          () => undefined
        )
        return current
      }
    )
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      enqueueTerminalInputWrite,
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal: vi.fn(async (_handle: string, action: { text?: string }) => {
        writes.push(action.text ?? '')
        return { handle: 'terminal-1', accepted: true, bytesWritten: action.text?.length ?? 0 }
      })
    } as unknown as OrcaRuntimeService
    const stream = {
      streamId: 7,
      terminal: 'terminal-1',
      ptyId: 'pty-1',
      client: { id: 'desktop-1', type: 'desktop' as const },
      isMobile: false,
      desktopClaimTail: desktopClaim
    } as unknown as TerminalMultiplexStream
    const state = {
      runtime,
      closed: false,
      streams: new Map([[stream.streamId, stream]]),
      notifyStreamWriteUnavailable: vi.fn()
    } as unknown as TerminalMultiplexCleanupStage
    installMultiplexSlotFrames(state)

    state.handleSlotFrame(stream, {
      opcode: TerminalStreamOpcode.Input,
      streamId: stream.streamId,
      seq: 1,
      payload: encodeTerminalStreamText('prior')
    })
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const quickCommand = dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'terminal.send',
      params: {
        terminal: 'terminal-1',
        text: 'quick\r',
        quickCommand: true,
        client: { id: 'desktop-1', type: 'desktop' }
      }
    })

    await vi.waitFor(() => expect(runtime.resolveLiveLeafForHandle).toHaveBeenCalled())
    await vi.waitFor(() => expect(runtime.enqueueTerminalInputWrite).toHaveBeenCalledTimes(2))
    expect(writes).toEqual([])

    releaseClaim(true)
    await expect(quickCommand).resolves.toMatchObject({ ok: true })
    expect(writes).toEqual(['prior', 'quick\r'])
  })

  it('reports queue overflow as write unavailable', async () => {
    const notifyStreamWriteUnavailable = vi.fn()
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      enqueueTerminalInputWrite: vi.fn().mockRejectedValue(new Error('terminal_input_queue_full')),
      getDriver: vi.fn().mockReturnValue({ kind: 'idle' }),
      resolveLiveLeafForHandle: vi.fn().mockReturnValue({ ptyId: 'pty-1' }),
      isTerminalRunningSettledPromptAgent: vi.fn().mockResolvedValue(false),
      sendTerminal: vi.fn()
    } as unknown as OrcaRuntimeService
    const stream = {
      streamId: 7,
      terminal: 'terminal-1',
      ptyId: 'pty-1',
      client: { id: 'desktop-1', type: 'desktop' as const },
      isMobile: false,
      desktopClaimTail: Promise.resolve(true)
    } as unknown as TerminalMultiplexStream
    const state = {
      runtime,
      closed: false,
      streams: new Map([[stream.streamId, stream]]),
      notifyStreamWriteUnavailable
    } as unknown as TerminalMultiplexCleanupStage
    installMultiplexSlotFrames(state)

    state.handleSlotFrame(stream, {
      opcode: TerminalStreamOpcode.Input,
      streamId: stream.streamId,
      seq: 1,
      payload: encodeTerminalStreamText('queued')
    })

    await vi.waitFor(() =>
      expect(notifyStreamWriteUnavailable).toHaveBeenCalledWith(stream, 'rejected')
    )
  })
})
