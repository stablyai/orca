import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { RelayedProviderOutput } from './relayed-provider-output'
import { jsonProperty } from '../../shared/json-stream/json-value-property'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'

function rig(passWhileHeld?: (line: string) => boolean) {
  const stdout = new Readable({ read() {} })
  const seen: string[] = []
  stdout.on('data', (chunk: Buffer) => seen.push(...chunk.toString().split('\n').filter(Boolean)))
  const acks: number[] = []
  // Each barrier waits until the test says the journal has written what was handed on.
  const waiting: (() => void)[] = []
  // Streamed text the journal holds only in memory; a forced barrier saves it.
  const journal = { liveText: false }
  const durable = vi.fn(
    (force: boolean) =>
      new Promise<boolean>((resolve) =>
        waiting.push(() => {
          journal.liveText &&= !force
          resolve(!journal.liveText)
        })
      )
  )
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
  return { output, seen, acks, durable, releaseDurable, journal }
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

  it("answers the daemon's ask while a replay is held by keeping it, never letting it go unsaved", async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      durable: async () => true,
      passWhileHeld: () => false,
      ack: async (seq, keepFrom, flags) => {
        acks.push(
          `${seq}${keepFrom === undefined ? '' : ` keep ${keepFrom}`}${flags?.cut ? ' cut' : ''}`
        )
      }
    })
    output.restartAt(10)
    output.line('relayData', 11, 'event-11')
    output.line('relayData', 12, 'event-12')
    // Nothing is taken while held, so an ordinary ack has nothing to say.
    await output.settle()
    expect(acks).toEqual([])
    // The daemon's ask (its memory cap): received, but kept for a later attach.
    await output.settle(true)
    expect(acks).toEqual(['12 keep 11'])
    // Unsaved held lines are never let go: another ask keeps them still, and the daemon spools them.
    await output.settle(true)
    expect(acks).toEqual(['12 keep 11'])
    // Once handed on, an ask while keeping (the file cap) lets them go, said as a cut.
    await output.release()
    await output.settle(true)
    expect(acks).toEqual(['12 keep 11', '12 cut'])
  })

  it("keeps saving until its acks reach the daemon's ask, so a short first answer never stalls the agent", async () => {
    const { output, acks, releaseDurable, journal } = rig()
    output.restartAt(0)
    output.line('relayData', 1, 'one')
    output.line('relayData', 2, 'two')
    // The daemon asked through 4; lines 3 and 4 are still on their way.
    journal.liveText = true
    const first = output.settle(true, 4)
    await releaseDurable()
    await first
    expect(acks).toEqual([2])
    // A command keeps streaming unsaved text: an ordinary ack would wait, and the daemon won't ask again.
    output.line('relayData', 3, 'three')
    output.line('relayData', 4, 'four')
    journal.liveText = true
    const next = output.settle()
    await releaseDurable()
    await next
    expect(acks).toEqual([2, 4])
    // Past the ask, ordinary acks wait for the text again.
    output.line('relayData', 5, 'five')
    journal.liveText = true
    const later = output.settle()
    await releaseDurable()
    await later
    expect(acks).toEqual([2, 4])
  })

  it('learns from the ack reply when the daemon let a held replay go at its file cap', async () => {
    const acks: string[] = []
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      durable: async () => true,
      passWhileHeld: () => false,
      ack: async (seq, keepFrom, flags) => {
        acks.push(`${seq} keep ${keepFrom}${flags?.held ? ' held' : ''}`)
        // The daemon's file cap released everything it was asked to keep.
        return { ackedThrough: seq }
      }
    })
    output.restartAt(10)
    output.line('relayData', 11, 'event-11')
    output.line('relayData', 12, 'event-12')
    await output.settle(true)
    output.line('relayData', 13, 'event-13')
    // Kept from the first line still kept, never from below what the daemon already released.
    await output.settle(true)
    expect(acks).toEqual(['12 keep 11 held', '13 keep 13 held'])
  })

  it('keeps a cut the ack floor reported until an ack carrying it succeeds', async () => {
    const sent: string[] = []
    let fail = true
    let cutOnce = true
    const output = new RelayedProviderOutput({
      stdout: new Readable({ read() {} }),
      durable: async () => true,
      ackFloor: {
        observe: () => {},
        floor: () => 2,
        tookCut: () => {
          const took = cutOnce
          cutOnce = false
          return took
        }
      },
      ack: async (seq, keepFrom, flags) => {
        sent.push(`${seq} keep ${keepFrom}${flags?.cut ? ' cut' : ''}`)
        if (fail) {
          fail = false
          throw new Error('daemon busy')
        }
      }
    })
    output.restartAt(0)
    output.line('relayData', 1, 'one')
    output.line('relayData', 2, 'two')
    await output.settle()
    output.line('relayData', 3, 'three')
    await output.settle()
    expect(sent).toEqual(['2 keep 2 cut', '3 keep 2 cut'])
  })

  it('never acks a line whose streamed text is only in memory, unless the ask saved it first', async () => {
    const { output, acks, releaseDurable, journal } = rig()
    output.restartAt(0)
    output.line('relayData', 1, 'delta-1')
    journal.liveText = true
    const routine = output.settle()
    await releaseDurable()
    await routine
    // A crash now replays delta-1, so its text is never lost.
    expect(acks).toEqual([])
    const asked = output.settle(true)
    await releaseDurable()
    await asked
    expect(acks).toEqual([1])
  })

  it('acks only the records a paused reader took, so a crash replays the rest', async () => {
    const stdout = new Readable({ read() {} })
    const acks: number[] = []
    const output = new RelayedProviderOutput({
      stdout,
      ack: async (seq) => {
        acks.push(seq)
      }
    })
    const taken: number[] = []
    // The journal's drain pauses the reader after its first record.
    const reader = createProviderRecordReader({
      stdout: Object.assign(stdout, { relayRecords: output.recordTaking }),
      onRecord: (record) => {
        taken.push(Number(jsonProperty(record, 'n')))
        if (taken.length === 1) {
          reader.pause()
        }
      },
      onRejected: () => {},
      onFatal: () => {}
    })
    output.restartAt(0)
    for (const n of [1, 2, 3]) {
      output.line('relayData', n, JSON.stringify({ n }))
    }
    await settle()
    await output.settle()
    expect(taken).toEqual([1])
    expect(acks).toEqual([1])
    reader.resume()
    await settle()
    await output.settle()
    expect(taken).toEqual([1, 2, 3])
    expect(acks).toEqual([1, 3])
  })

  it('hands a large held replay on in order, with lines that came during it after it', async () => {
    const { output, seen } = rig(() => false)
    output.restartAt(0)
    for (let seq = 1; seq <= 50_000; seq += 1) {
      output.line('relayData', seq, `line-${seq}`)
    }
    const released = output.release()
    // Lines that come during the replay queue behind it.
    output.line('relayData', 50_001, 'line-50001')
    await released
    await settle()
    expect(output.holding).toBe(false)
    expect(seen).toHaveLength(50_001)
    expect(seen.every((line, index) => line === `line-${index + 1}`)).toBe(true)
  })
})
