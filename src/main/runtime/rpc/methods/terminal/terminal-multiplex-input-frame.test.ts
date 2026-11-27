import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  encodeTerminalStreamText,
  TerminalStreamOpcode
} from '../../../../../shared/terminal/stream/terminal-stream-protocol'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { RuntimeTerminalWriter } from '../../../terminal/input/runtime-terminal-writer'
import { TerminalInputSequenceLedger } from './terminal-input-sequence-ledger'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import { handleMultiplexInputFrame } from './terminal-multiplex-input-frame'
import type { TerminalMultiplexStream, TerminalViewportClient } from './terminal-stream-types'

afterEach(() => {
  vi.useRealTimers()
})

function unsequencedInputSender(
  runtime: unknown,
  terminal: string,
  client?: TerminalViewportClient
): (text: string) => void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unsequenced input from a desktop stream only calls `runtime` and `notifyStreamWriteUnavailable`.
  const state = {
    runtime,
    notifyStreamWriteUnavailable: vi.fn()
  } as unknown as TerminalMultiplexConnection
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unsequenced desktop stream reads only these fields.
  const stream = {
    terminal,
    ptyId: 'pty-1',
    client,
    isMobile: false,
    inputSessionId: null,
    unsequencedInputTail: Promise.resolve(),
    desktopClaimTail: Promise.resolve(true)
  } as unknown as TerminalMultiplexStream
  const ledger = new TerminalInputSequenceLedger()
  return (text) =>
    handleMultiplexInputFrame(state, ledger, stream, {
      opcode: TerminalStreamOpcode.Input,
      streamId: 1,
      seq: 0,
      payload: encodeTerminalStreamText(text)
    })
}

describe('handleMultiplexInputFrame', () => {
  it('writes unsequenced frames to the PTY in send order while a large paste is chunked', async () => {
    const written: string[] = []
    const writer = new RuntimeTerminalWriter((_ptyId, data) => {
      written.push(data)
      return true
    })
    const send = unsequencedInputSender(
      {
        sendTerminal: async (
          _handle: string,
          action: { text: string },
          options: Parameters<RuntimeTerminalWriter['writeAction']>[3]
        ) => {
          await writer.writeAction('pty-1', action, action.text, options)
          return { handle: 'terminal-1', accepted: true, bytesWritten: 0 }
        }
      },
      'terminal-1'
    )
    const paste = 'a'.repeat(50 * 1024)
    const inputs = ['\x1b[200~', paste, '\x1b[201~', 'x']
    for (const text of inputs) {
      send(text)
    }

    await vi.waitFor(() => expect(written.join('').length).toBe(inputs.join('').length))
    expect(written.map((data) => (data === paste.slice(0, data.length) ? 'paste' : data))).toEqual([
      '\x1b[200~',
      'paste',
      'paste',
      'paste',
      'paste',
      '\x1b[201~',
      'x'
    ])
  })

  it('drops a frame that arrives during a mobile lock even if the lock is released before its turn', async () => {
    vi.useFakeTimers()
    const sent: string[] = []
    let driverKind = 'idle'
    let finishFirst = (): void => {}
    const send = unsequencedInputSender(
      {
        getDriver: () => ({ kind: driverKind }),
        sendTerminal: async (_handle: string, action: { text: string }) => {
          sent.push(action.text)
          if (action.text === 'first') {
            await new Promise<void>((resolve) => (finishFirst = resolve))
          }
          return { handle: 'terminal-1', accepted: true, bytesWritten: 0 }
        }
      },
      'terminal-1',
      { id: 'desktop-1', type: 'desktop' }
    )

    send('first')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual(['first'])
    driverKind = 'mobile'
    send('typed-during-lock')
    driverKind = 'idle'
    finishFirst()
    await vi.runAllTimersAsync()
    send('after-release')
    await vi.runAllTimersAsync()

    expect(sent).toEqual(['first', 'after-release'])
  })

  it('bounds queued frames by one endpoint re-attach wait and gives a frame queued before the loss the full wait', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const runtime = new OrcaRuntimeService()
    const writes: { data: string; reattached: boolean }[] = []
    let reattached = false
    let finishAttach = (_attached: boolean): void => {}
    runtime.setPtyController({
      write: (_ptyId: string, data: string) => {
        writes.push({ data, reattached })
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'bash',
      attach: () => new Promise<boolean>((resolve) => (finishAttach = resolve))
    })
    runtime.registerPty('pty-1', 'wt-1')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both protected members are declared on OrcaRuntimeService's inheritance chain.
    const internals = runtime as unknown as {
      issuePtyHandle: (pty: unknown) => string
      ptysById: Map<string, unknown>
    }
    const handle = internals.issuePtyHandle(internals.ptysById.get('pty-1'))
    const send = unsequencedInputSender(runtime, handle)
    try {
      // Stuck re-attach: frames whose turn comes once its 10 s bound has run out get no fresh wait.
      runtime.notePtyEndpointLoss('pty-1')
      for (const text of ['a', 'b', 'c']) {
        send(text)
      }
      vi.advanceTimersByTime(10_000)
      await vi.waitFor(() => expect(writes.map(({ data }) => data)).toEqual(['a', 'b', 'c']), {
        timeout: 3_000
      })

      finishAttach(true)
      await new Promise((resolve) => setImmediate(resolve))
      // A frame that arrived 15 s before a new loss still waits for that re-attach.
      send('d')
      vi.advanceTimersByTime(15_000)
      runtime.notePtyEndpointLoss('pty-1')
      await vi.advanceTimersByTimeAsync(50)
      expect(writes).toHaveLength(3)
      reattached = true
      finishAttach(true)
      await vi.waitFor(() => expect(writes[3]).toEqual({ data: 'd', reattached: true }))
    } finally {
      await runtime.onPtyExit('pty-1', 0)
    }
  })
})
