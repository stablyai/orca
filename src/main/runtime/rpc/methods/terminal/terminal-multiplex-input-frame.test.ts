import { describe, expect, it, vi } from 'vitest'
import { TerminalStreamOpcode } from '../../../../../shared/terminal-stream-protocol'
import { iterateTerminalInputChunks } from '../../../../../shared/terminal-input'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { handleMultiplexInputFrame } from './terminal-multiplex-input-frame'
import { TerminalInputSequenceLedger } from './terminal-input-sequence-ledger'
import type { TerminalMultiplexConnection } from './terminal-multiplex-connection'
import type { TerminalMultiplexStream } from './terminal-stream-types'

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

// Writes as the runtime's terminal writer does: a large text yields once for its size check, then
// goes to the PTY in 16 KiB chunks with a yield between them; a small one is written at once.
function chunkingRuntime(writes: { terminal: string; data: string }[]): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input path calls only getDriver and sendTerminal on the runtime.
  return {
    getDriver: () => ({ kind: 'idle' }),
    sendTerminal: vi.fn(async (terminal: string, action: { text: string }) => {
      const chunks = [...iterateTerminalInputChunks(action.text)]
      if (chunks.length > 1) {
        await nextTurn()
      }
      for (const [index, chunk] of chunks.entries()) {
        if (index > 0) {
          await nextTurn()
        }
        writes.push({ terminal, data: chunk })
      }
      return { accepted: true }
    })
  } as unknown as OrcaRuntimeService
}

function desktopStream(streamId: number, terminal: string): TerminalMultiplexStream {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: handleMultiplexInputFrame reads only these stream fields on the unsequenced path.
  return {
    streamId,
    terminal,
    ptyId: `pty-${terminal}`,
    client: { id: `client-${streamId}`, type: 'desktop' },
    isMobile: false,
    inputSessionId: null,
    desktopClaimTail: Promise.resolve(true),
    outputBatcher: { noteInput: vi.fn() }
  } as unknown as TerminalMultiplexStream
}

function connection(runtime: OrcaRuntimeService): TerminalMultiplexConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the input path reads only runtime, notifyStreamWriteUnavailable and sendInputAck.
  return {
    runtime,
    notifyStreamWriteUnavailable: vi.fn(),
    sendInputAck: vi.fn()
  } as unknown as TerminalMultiplexConnection
}

function input(
  state: TerminalMultiplexConnection,
  ledger: TerminalInputSequenceLedger,
  stream: TerminalMultiplexStream,
  text: string
): void {
  handleMultiplexInputFrame(state, ledger, stream, {
    opcode: TerminalStreamOpcode.Input,
    streamId: stream.streamId,
    seq: 0,
    payload: new TextEncoder().encode(text)
  })
}

// A paste as Ghostty sends it, in three writes, and the keys typed right after it.
function pasteThenKeys(lines: number, tag: string): string[] {
  const body = Array.from({ length: lines }, (_, i) => `${tag} paste line ${i}\n`).join('')
  return [PASTE_START, body, PASTE_END, 'x', '\r']
}

function written(writes: { terminal: string; data: string }[], terminal: string): string {
  return writes
    .filter((write) => write.terminal === terminal)
    .map((write) => write.data)
    .join('')
}

describe('unsequenced multiplex input', () => {
  it('writes a 50 KB bracketed paste as one block, before the keys typed after it', async () => {
    const writes: { terminal: string; data: string }[] = []
    const state = connection(chunkingRuntime(writes))
    const ledger = new TerminalInputSequenceLedger()
    const stream = desktopStream(1, 'a')
    const frames = pasteThenKeys(3000, 'a')
    const expected = frames.join('')
    expect(frames[1]!.length).toBeGreaterThan(50_000)

    for (const frame of frames) {
      input(state, ledger, stream, frame)
    }
    await vi.waitFor(() => expect(written(writes, 'a')).toHaveLength(expected.length))

    expect(written(writes, 'a')).toBe(expected)
    // The paste went in several chunks, and nothing landed between them.
    expect(writes.length).toBeGreaterThan(frames.length)
  })

  it('keeps each stream in order with several streams at once, without one waiting for another', async () => {
    const writes: { terminal: string; data: string }[] = []
    const state = connection(chunkingRuntime(writes))
    const ledger = new TerminalInputSequenceLedger()
    const streams = ['a', 'b', 'c'].map((terminal, index) => desktopStream(index + 1, terminal))
    const framesByStream = streams.map((stream, index) =>
      pasteThenKeys(1000 * (index + 1), stream.terminal)
    )

    // Interleaved as frames from three panes arrive on one connection.
    for (let frame = 0; frame < 5; frame += 1) {
      streams.forEach((stream, index) =>
        input(state, ledger, stream, framesByStream[index]![frame]!)
      )
    }
    const total = framesByStream.reduce((sum, frames) => sum + frames.join('').length, 0)
    await vi.waitFor(() =>
      expect(writes.reduce((sum, write) => sum + write.data.length, 0)).toBe(total)
    )

    streams.forEach((stream, index) => {
      expect(written(writes, stream.terminal)).toBe(framesByStream[index]!.join(''))
    })
    // Stream a's whole input finished before stream c's paste did: no queue across streams.
    const lastOf = (terminal: string): number =>
      writes.map((write) => write.terminal).lastIndexOf(terminal)
    expect(lastOf('a')).toBeLessThan(lastOf('c'))
  })
})
