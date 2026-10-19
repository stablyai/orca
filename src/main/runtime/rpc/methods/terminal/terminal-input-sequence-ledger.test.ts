import { describe, expect, it } from 'vitest'
import {
  TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS,
  TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_UNKNOWN_SEQS,
  TerminalInputSequenceLedger,
  type TerminalInputWriteOutcome
} from './terminal-input-sequence-ledger'

const applied = (appliedSeq: number) => ({ kind: 'applied', appliedSeq })
const resend = (appliedSeq: number) => ({ kind: 'resend', appliedSeq })

function recordingWrites() {
  const writes: string[] = []
  const write =
    (text: string, outcome: TerminalInputWriteOutcome = 'applied') =>
    async (): Promise<TerminalInputWriteOutcome> => {
      if (outcome === 'applied') {
        writes.push(text)
      }
      return outcome
    }
  return { writes, write }
}

function gatedWrite(writes: string[], text: string) {
  let release = (): void => {}
  const write = (): Promise<TerminalInputWriteOutcome> =>
    new Promise((resolve) => {
      release = () => {
        writes.push(text)
        resolve('applied')
      }
    })
  return { write, release: () => release() }
}

describe('TerminalInputSequenceLedger', () => {
  it('runs writes of one session in sequence order, even when an earlier write is slow', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const writes: string[] = []
    const first = gatedWrite(writes, 'a')
    const settledFirst = ledger.admit('pty-1', 'session', 1, first.write)
    const second = ledger.admit('pty-1', 'session', 2, async () => {
      writes.push('b')
      return 'applied'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(writes).toEqual([])
    first.release()
    await expect(Promise.all([settledFirst, second])).resolves.toEqual([applied(1), applied(2)])
    expect(writes).toEqual(['a', 'b'])
  })

  it('advances past a write that may have reached the terminal and never retries it', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    await expect(
      ledger.admit('pty-1', 'session', 1, async () => {
        throw new Error('write failed')
      })
    ).resolves.toEqual({ kind: 'delivery-unknown', appliedSeq: 1 })
    // Its ack may have died with the connection: a duplicate must still read as unknown, never applied.
    await expect(ledger.admit('pty-1', 'session', 1, write('dup'))).resolves.toEqual({
      kind: 'delivery-unknown',
      appliedSeq: 1
    })
    await expect(ledger.admit('pty-1', 'session', 2, write('b'))).resolves.toEqual(applied(2))
    expect(writes).toEqual(['b'])
  })

  it('never acks a refused write, asks for it again, and writes it when resent', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    await ledger.admit('pty-1', 'session', 1, write('a'))
    // The SSH provider is reconnecting, so the PTY refuses seq 2; seq 3 is already queued behind it.
    const refused = ledger.admit('pty-1', 'session', 2, write('b', 'refused'))
    const queued = ledger.admit('pty-1', 'session', 3, write('c'))
    await expect(refused).resolves.toEqual(resend(1))
    await expect(queued).resolves.toEqual(resend(1))
    // Typed on the same stream after the refusal: running it would skip the refused bytes.
    await expect(ledger.admit('pty-1', 'session', 4, write('d'))).resolves.toEqual(resend(1))
    expect(writes).toEqual(['a'])

    // The same live stream resends from seq 2, and input typed after the resend keeps flowing.
    const resent = [2, 3, 4, 5].map((seq) =>
      ledger.admit('pty-1', 'session', seq, write('bcde'[seq - 2]))
    )
    await expect(Promise.all(resent)).resolves.toEqual([2, 3, 4, 5].map(applied))
    expect(writes).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('treats every stream of a session alike: a replacement whose replay raced a refusal is asked to resend', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    // Old stream: seq 1 is a slow paste chunk, seq 2 queued behind it and then refused.
    const slow = gatedWrite(writes, '1')
    void ledger.admit('pty-1', 'session', 1, slow.write)
    void ledger.admit('pty-1', 'session', 2, write('2', 'refused'))
    // Replacement stream replays 1 and 2, then types seq 3.
    const replay = [1, 2].map((seq) => ledger.admit('pty-1', 'session', seq, write(String(seq))))
    const typed = ledger.admit('pty-1', 'session', 3, write('3'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    slow.release()
    // The replay of 2 runs after the refusal, so it is written, and 3 follows it.
    await expect(Promise.all([...replay, typed])).resolves.toEqual([
      applied(1),
      applied(2),
      applied(3)
    ])
    expect(writes).toEqual(['1', '2', '3'])
  })

  it('never writes a dead stream frame that arrives after a gap ahead of the resend that fills it', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    await ledger.admit('pty-1', 'session', 1, write('a', 'refused'))
    // The dead stream's later frame races the replacement's resend of seq 1.
    await expect(ledger.admit('pty-1', 'session', 3, write('c'))).resolves.toEqual(resend(0))
    const resent = [1, 2, 3].map((seq) =>
      ledger.admit('pty-1', 'session', seq, write('abc'[seq - 1]))
    )
    await expect(Promise.all(resent)).resolves.toEqual([1, 2, 3].map(applied))
    expect(writes).toEqual(['a', 'b', 'c'])
  })

  it('starts a new session at whatever sequence the client is up to', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { write } = recordingWrites()
    await expect(ledger.admit('pty-1', 'session', 40, write('a'))).resolves.toEqual(applied(40))
    await expect(ledger.admit('pty-1', 'session', 41, write('b'))).resolves.toEqual(applied(41))
  })

  it('scopes sequences by PTY so a session reused on another terminal is not deduped', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    await ledger.admit('pty-1', 'session', 5, write('a'))
    await ledger.admit('pty-2', 'session', 5, write('b'))
    expect(writes).toEqual(['a', 'b'])
  })

  it('evicts the least recently used session past its bound', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { writes, write } = recordingWrites()
    await ledger.admit('pty-1', 'oldest', 1, write('oldest'))
    for (let index = 0; index < TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS; index += 1) {
      void ledger.admit('pty-1', `session-${index}`, 1, write('new'))
    }
    await ledger.admit('pty-1', 'session-0', 1, write('kept-dup'))
    await ledger.admit('pty-1', 'oldest', 1, write('evicted-dup'))
    expect(writes.filter((text) => text.endsWith('dup'))).toEqual(['evicted-dup'])
  })

  it('settles a duplicate only after the original write it repeats', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const writes: string[] = []
    const first = gatedWrite(writes, 'a')
    void ledger.admit('pty-1', 'session', 1, first.write)
    let duplicateSettled = false
    const duplicate = ledger.admit('pty-1', 'session', 1, async () => 'applied')
    void duplicate.then(() => {
      duplicateSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(duplicateSettled).toBe(false)
    first.release()
    await expect(duplicate).resolves.toEqual(applied(1))
    expect(writes).toEqual(['a'])
  })

  it('answers a duplicate for its own sequence, and as unknown once that outcome is forgotten', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const { write } = recordingWrites()
    await ledger.admit('pty-1', 'session', 1, write('a'))
    await ledger.admit('pty-1', 'session', 2, write('b', 'delivery-unknown'))
    const last = TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_UNKNOWN_SEQS + 3
    for (let seq = 3; seq <= last; seq += 1) {
      await ledger.admit(
        'pty-1',
        'session',
        seq,
        write('x', seq === last ? 'applied' : 'delivery-unknown')
      )
    }
    await expect(ledger.admit('pty-1', 'session', 1, write('dup'))).resolves.toEqual({
      kind: 'delivery-unknown',
      appliedSeq: 1
    })
    await expect(ledger.admit('pty-1', 'session', last, write('dup'))).resolves.toEqual(
      applied(last)
    )
    await expect(ledger.admit('pty-1', 'session', last - 1, write('dup'))).resolves.toEqual({
      kind: 'delivery-unknown',
      appliedSeq: last - 1
    })
  })

  it('names each ledger so a client can tell a restarted runtime from the one it sent to', () => {
    expect(new TerminalInputSequenceLedger().id).not.toBe(new TerminalInputSequenceLedger().id)
  })
})
