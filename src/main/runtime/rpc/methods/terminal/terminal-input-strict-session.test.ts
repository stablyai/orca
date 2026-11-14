import { describe, expect, it, vi } from 'vitest'
import {
  TerminalInputSequenceLedger,
  TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS
} from './terminal-input-sequence-ledger'

const binding = { ptyId: 'pty', processIncarnation: 'process', generation: 1 }
const noop = () => {}
const applied = async () => 'applied' as const

function held() {
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = vi.fn(async () => {
    await gate
    return 'applied' as const
  })
  return { write, release }
}

describe('strict input session reservations', () => {
  it('charges duplicate and empty requests before chaining, and pins busy sessions until every task settles', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const token = ledger.openStrictSession('phone', binding)!
    const gate = held()
    const requests = Array.from({ length: 128 }, () =>
      ledger.admitStrict('pty', 'phone', token, 1, 0, 'same', noop, gate.write)
    )
    await Promise.resolve()
    expect(gate.write).toHaveBeenCalledTimes(1)
    expect(
      await ledger.admitStrict('pty', 'phone', token, 1, 0, 'same', noop, gate.write)
    ).toMatchObject({ kind: 'resend' })
    expect(ledger.openStrictSession('phone', binding)).toBeNull()
    gate.release()
    await Promise.all(requests)
    expect(gate.write).toHaveBeenCalledTimes(1)
    expect(ledger.openStrictSession('phone', binding)).toEqual(expect.any(String))
  })

  it('bounds per-owner and aggregate bytes across owners and releases them only after the held task finishes', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const gate = held()
    const tokens = Array.from({ length: 5 }, (_, index) =>
      ledger.openStrictSession(String(index), binding)!
    )
    const requests = tokens
      .slice(0, 4)
      .map((token, index) =>
        ledger.admitStrict(
          'pty',
          String(index),
          token,
          1,
          16 * 1024 * 1024,
          'paste',
          noop,
          gate.write
        )
      )
    await Promise.resolve()
    expect(
      await ledger.admitStrict('pty', '0', tokens[0], 2, 2 * 1024 * 1024, 'extra', noop, gate.write)
    ).toMatchObject({ kind: 'resend' })
    expect(
      await ledger.admitStrict('pty', '4', tokens[4], 1, 1, 'a', noop, gate.write)
    ).toMatchObject({ kind: 'resend' })
    gate.release()
    await Promise.all(requests)
    const fresh = ledger.openStrictSession('4', binding)!
    expect(await ledger.admitStrict('pty', '4', fresh, 1, 1, 'a', noop, applied)).toMatchObject({
      kind: 'applied'
    })
  })

  it('never evicts a busy strict tail or recreates an evicted token from a late send', async () => {
    const ledger = new TerminalInputSequenceLedger()
    const evicted = ledger.openStrictSession('idle', binding)!
    const busy = ledger.openStrictSession('busy', binding)!
    const gate = held()
    const request = ledger.admitStrict('pty', 'busy', busy, 1, 1, 'a', noop, gate.write)
    await Promise.resolve()
    for (let index = 0; index < TERMINAL_INPUT_SEQUENCE_LEDGER_MAX_SESSIONS; index += 1) {
      ledger.openStrictSession(String(index), binding)
    }
    expect(ledger.openStrictSession('busy', binding)).toBeNull()
    expect(
      await ledger.admitStrict('pty', 'idle', evicted, 1, 1, 'a', noop, gate.write)
    ).toMatchObject({ kind: 'resend' })
    gate.release()
    expect(await request).toMatchObject({ kind: 'applied' })
    expect(gate.write).toHaveBeenCalledTimes(1)
  })
})
