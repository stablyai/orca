import { describe, expect, it } from 'vitest'
import {
  CHANNEL_SESSION,
  commandDetailChannel
} from './structured-command-detail-channel.test-fixture'

/** One lane read per reader, the way each reader's lane entry samples it. */
function laneReads(
  h: ReturnType<typeof commandDetailChannel>,
  readers: number
): ReturnType<ReturnType<typeof commandDetailChannel>['channel']['laneRead']>[] {
  return Array.from({ length: readers }, () => h.channel.laneRead(CHANNEL_SESSION))
}

describe('command detail authority sampling (one read per lane)', () => {
  for (const rows of [1, 20]) {
    for (const readers of [1, 2]) {
      it(`present lane: ${rows} command row(s) x ${readers} reader(s) samples membership once per reader`, () => {
        const h = commandDetailChannel({ rows })
        const reads = laneReads(h, readers)
        for (const read of reads) {
          expect(read.kind).toBe('roster')
          if (read.kind === 'roster') {
            expect(read.state?.commandDetailsAvailable).toHaveLength(rows)
          }
        }
        expect(h.membership).toHaveBeenCalledTimes(readers)
        // One record read for the lane's fence and one for owner authority, whatever the row count.
        expect(h.getConversation).toHaveBeenCalledTimes(2 * readers)
      })

      it(`absent lane: ${rows} retained tuple(s) x ${readers} reader(s) samples membership once per reader`, () => {
        const h = commandDetailChannel({ rows })
        h.state.open = false
        for (const read of laneReads(h, readers)) {
          expect(read.kind).toBe('availability')
          if (read.kind === 'availability') {
            expect(read.keep(h.tuples())).toHaveLength(rows)
          }
        }
        expect(h.membership).toHaveBeenCalledTimes(readers)
      })
    }
  }

  it('a retired membership withdraws every row after one sample, on both lanes', () => {
    const h = commandDetailChannel({ rows: 20 })
    h.state.member = false
    const [present] = laneReads(h, 1)
    expect(present!.kind === 'roster' && present!.state?.commandDetailsAvailable).toBeFalsy()
    h.state.open = false
    const [absent] = laneReads(h, 1)
    expect(absent!.kind === 'availability' && absent!.keep(h.tuples())).toEqual([])
    expect(h.membership).toHaveBeenCalledTimes(2)
  })

  it('the next run samples again: a membership change between runs is seen', () => {
    const h = commandDetailChannel({ rows: 3 })
    const [first] = laneReads(h, 1)
    expect(first!.kind === 'roster' && first!.state?.commandDetailsAvailable).toHaveLength(3)
    h.state.member = false
    const [second] = laneReads(h, 1)
    expect(second!.kind === 'roster' && second!.state?.commandDetailsAvailable).toBeFalsy()
    expect(h.membership).toHaveBeenCalledTimes(2)
  })

  it('a session with no command rows never samples membership', () => {
    const h = commandDetailChannel({ rows: 0 })
    laneReads(h, 2)
    expect(h.membership).not.toHaveBeenCalled()
  })
})

describe('command detail on the canonical slot', () => {
  it('reads the exact bytes for the current tuple with a live owner, and nothing for a wrong tuple', () => {
    const h = commandDetailChannel()
    const [tuple] = h.tuples()
    expect(h.channel.commandDetail(CHANNEL_SESSION, tuple!)).toBe(h.exact.get(tuple!.childWorkId))
    expect(
      h.channel.commandDetail(CHANNEL_SESSION, { ...tuple!, generation: tuple!.generation + 1 })
    ).toBeNull()
    expect(
      h.channel.commandDetail(CHANNEL_SESSION, { ...tuple!, invocationId: 'other' })
    ).toBeNull()
  })

  it('an equal fence parked in recovery, or unreconciled, withdraws the bytes and availability', () => {
    for (const owner of [
      { handoffStage: 'recovering', handoffOperationId: null },
      { unreconciled: true }
    ]) {
      const h = commandDetailChannel()
      const [tuple] = h.tuples()
      Object.assign(h.state.conversation.ownerObservation, owner)
      expect(h.channel.commandDetail(CHANNEL_SESSION, tuple!)).toBeNull()
      const [read] = laneReads(h, 1)
      expect(read!.kind === 'roster' && read!.state?.commandDetailsAvailable).toBeFalsy()
    }
  })

  it('an older fence reads only on the exact proven release; a mismatched proof or new reservation does not', () => {
    const released = {
      claimStatus: 'released',
      unreconciled: false,
      ownerProcess: null,
      reservedSpawnToken: null,
      handoffStage: null,
      handoffOperationId: null
    }
    const cases: [Record<string, unknown>, boolean][] = [
      [{ ...released, deathEvidence: { kind: 'exit-observed', ownerFence: 5 } }, true],
      [{ ...released, deathEvidence: { kind: 'exit-observed', ownerFence: 4 } }, false],
      [{ ...released, deathEvidence: null }, false],
      [
        {
          ...released,
          claimStatus: 'reserved',
          reservedSpawnToken: 'next',
          deathEvidence: { kind: 'exit-observed', ownerFence: 5 }
        },
        false
      ]
    ]
    for (const [owner, reads] of cases) {
      const h = commandDetailChannel({ fence: 5 })
      const [tuple] = h.tuples()
      h.state.conversation.currentFence = 6
      h.state.conversation.ownerObservation = owner
      const text = h.channel.commandDetail(CHANNEL_SESSION, tuple!)
      expect(text).toBe(reads ? h.exact.get(tuple!.childWorkId) : null)
    }
  })
})
