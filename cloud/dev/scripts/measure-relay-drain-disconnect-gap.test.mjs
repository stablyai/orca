import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  measureDrainDisconnectGap,
  readDrainCloses,
  readReconnectGrants
} from './measure-relay-drain-disconnect-gap.mjs'

const start = Date.parse('2026-10-06T10:00:00Z')
const at = (seconds) => new Date(start + seconds * 1000).toISOString()

function close(host, seconds, reason, splices = 0) {
  return {
    timestamp: at(seconds),
    jsonPayload: {
      message:
        `[orca-relay] control closed host=${host} gen=3 state=closed ageMs=100 app="1.4.0"` +
        ` splices=${splices} pending=0 code=4001 reason=${JSON.stringify(reason)}`
    }
  }
}

function grant(host, seconds, cellId) {
  return {
    timestamp: at(seconds),
    textPayload: `[orca-relay] assignment granted lane=drain-return hinted=true host=${host} cell=${cellId}`
  }
}

describe('drain disconnect gap', () => {
  it('splits moved-first, cut-off and unresolved desktops and sums dropped phone sessions', () => {
    const closes = readDrainCloses([
      close('h-moved', 30, 'migration completed', 2),
      close('h-cut', 300, 'resolve configured director', 1),
      close('h-idle', 310, 'resolve configured director'),
      close('h-lost', 320, 'resolve configured director'),
      close('h-early', -5, 'resolve configured director'),
      // A later close of the same host is its next session, not the drain.
      close('h-cut', 900, 'resolve configured director', 7)
    ])
    const grants = readReconnectGrants([
      grant('h-moved', 20, 'c2'),
      grant('h-cut', 304, 'c2'),
      grant('h-idle', 330, 'c3'),
      grant('h-other', 5, 'c2'),
      grant('h-cut', 290, 'c1')
    ])
    const result = measureDrainDisconnectGap({
      sourceCellId: 'c1',
      drainStartedAt: start,
      drainEndedAt: start + 1_200_000,
      controlsAtDrainStart: 5,
      closes,
      grants
    })
    assert.equal(result.closedHosts, 4)
    assert.equal(result.closeCoverage, 0.8)
    assert.equal(result.movedFirst, 1)
    assert.equal(result.cutOff, 2)
    assert.equal(result.cutOffUnresolved, 1)
    assert.equal(result.otherClose, 0)
    assert.deepEqual(result.cutOffGap, { count: 2, p50Ms: 4000, p95Ms: 20000, maxMs: 20000 })
    assert.equal(result.phoneSessionsDropped, 3)
  })

  it('times desktops that left the source region until a grant brings them back', () => {
    const result = measureDrainDisconnectGap({
      sourceCellId: 'a1',
      drainStartedAt: start,
      drainEndedAt: start + 1_200_000,
      controlsAtDrainStart: 2,
      closes: readDrainCloses([
        close('h-away', 100, 'resolve configured director'),
        close('h-stuck', 100, 'resolve configured director')
      ]),
      grants: readReconnectGrants([
        grant('h-away', 101, 'u1'),
        grant('h-away', 3701, 'a2'),
        grant('h-stuck', 102, 'u1')
      ]),
      cellRegions: { a1: 'asia-east2', a2: 'asia-east2', u1: 'us-central1' }
    })
    assert.equal(result.leftSourceRegion, 2)
    assert.equal(result.leftSourceRegionStillAway, 1)
    assert.equal(result.timeUntilBack.maxMs, 3_600_000)
  })

  it('keeps each host earliest close when the export is newest first', () => {
    const result = measureDrainDisconnectGap({
      sourceCellId: 'c1',
      drainStartedAt: start,
      drainEndedAt: start + 1_200_000,
      controlsAtDrainStart: 1,
      closes: readDrainCloses([
        close('h', 300, 'resolve configured director'),
        close('h', 60, 'resolve configured director', 3)
      ]),
      grants: readReconnectGrants([grant('h', 120, 'c2')])
    })
    assert.equal(result.movedFirst, 0)
    assert.equal(result.cutOff, 1)
    assert.deepEqual(result.cutOffGap, { count: 1, p50Ms: 60000, p95Ms: 60000, maxMs: 60000 })
    assert.equal(result.phoneSessionsDropped, 3)
  })

  it('refuses an invalid drain start time', () => {
    assert.throws(
      () =>
        measureDrainDisconnectGap({
          sourceCellId: 'c1',
          drainStartedAt: Date.parse('not a time'),
          drainEndedAt: start,
          controlsAtDrainStart: 1,
          closes: [],
          grants: []
        }),
      /drain start time is invalid/
    )
  })

  it('leaves out closes after the drain ended and refuses a bad end time', () => {
    const input = {
      sourceCellId: 'c1',
      drainStartedAt: start,
      drainEndedAt: start + 600_000,
      controlsAtDrainStart: 1,
      closes: readDrainCloses([
        close('h-drained', 100, 'resolve configured director'),
        // The new container's session after the roll.
        close('h-new', 700, '', 4)
      ]),
      grants: readReconnectGrants([grant('h-drained', 650, 'c2')])
    }
    const result = measureDrainDisconnectGap(input)
    assert.equal(result.closedHosts, 1)
    assert.equal(result.otherClose, 0)
    assert.equal(result.phoneSessionsDropped, 0)
    // A grant after the window still ends that host's gap.
    assert.equal(result.cutOffGap.maxMs, 550_000)
    for (const drainEndedAt of [Number.NaN, start]) {
      assert.throws(
        () => measureDrainDisconnectGap({ ...input, drainEndedAt }),
        /drain end time is invalid/
      )
    }
  })

  it('ignores lines that are not the two it reads', () => {
    assert.deepEqual(readDrainCloses([{ timestamp: at(0), textPayload: 'unrelated' }]), [])
    assert.deepEqual(
      readReconnectGrants([grant('h', 0, 'c1')].map((entry) => ({
        ...entry,
        textPayload: entry.textPayload.replace('hinted=true', 'hinted=false')
      }))),
      []
    )
  })
})
