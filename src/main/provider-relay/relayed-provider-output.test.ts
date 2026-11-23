import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RelayedProviderOutput } from './relayed-provider-output'

function rig(passWhileHeld?: (line: string) => boolean) {
  const stdout = new Readable({ read() {} })
  const seen: string[] = []
  stdout.on('data', (chunk: Buffer) => seen.push(...chunk.toString().split('\n').filter(Boolean)))
  const acks: number[] = []
  // Each barrier waits until the test says the journal has written what was handed on.
  const waiting: (() => void)[] = []
  const durable = vi.fn(() => new Promise<void>((resolve) => waiting.push(resolve)))
  const output = new RelayedProviderOutput({
    stdout,
    durable,
    ack: async (seq) => {
      acks.push(seq)
    },
    ...(passWhileHeld ? { passWhileHeld } : {})
  })
  const releaseDurable = async () => {
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      waiting.splice(0).forEach((resolve) => resolve())
    }
  }
  return { output, seen, acks, durable, releaseDurable }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('relayed provider output', () => {
  it('an app killed mid-replay resumes from its last ack with no gap and no repeat of held requests', async () => {
    const first = rig()
    first.output.restartAt(0)
    first.output.line('relayPending', 2, 'ask')
    for (const seq of [1, 2, 3, 4]) {
      first.output.line('relayData', seq, `line-${seq}`)
    }
    const settling = first.output.settle()
    await settle()
    // Nothing is acked until the journal holds what was handed on.
    expect(first.acks).toEqual([])
    await first.releaseDurable()
    await settling
    expect(first.acks).toEqual([4])
    // The request was handed on once even though the spool carries it too.
    expect(first.seen).toEqual(['ask', 'line-1', 'line-3', 'line-4'])

    // The next launch attaches from the ack; the daemon replays what came after it.
    const second = rig()
    expect(second.output.restartAt(4)).toBe(4)
    for (const seq of [3, 4, 5, 6]) {
      second.output.line('relayData', seq, `line-${seq}`)
    }
    await settle()
    expect(second.seen).toEqual(['line-5', 'line-6'])
  })

  it('a held reattach lets answers through but never acks past lines it still holds', async () => {
    const { output, seen, acks, releaseDurable } = rig((line) => line.startsWith('answer'))
    output.restartAt(10)
    output.line('relayData', 11, 'event-11')
    output.line('relayData', 12, 'answer-12')
    const early = output.settle()
    await releaseDurable()
    await early
    expect(seen).toEqual(['answer-12'])
    expect(acks).toEqual([])

    output.release()
    const late = output.settle()
    await releaseDurable()
    await late
    expect(seen).toEqual(['answer-12', 'event-11'])
    expect(acks).toEqual([12])
  })
})
