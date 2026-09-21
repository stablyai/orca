import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  bridgedParityMembershipDrift,
  bridgedParityTallyDrift,
  classifyBridgedParity,
  BRIDGED_PARITY_BASELINE,
  BRIDGED_PARITY_EXCLUSIONS,
  BRIDGED_PARITY_FLAG,
  BRIDGED_PARITY_MEMBERS,
  BRIDGED_PARITY_OFF,
  BRIDGED_PARITY_NAMEABLE,
  type BridgedParityClass,
  type BridgedParityEvidence,
  type BridgedParityTally
} from './divergence-classes'

const base: BridgedParityEvidence = {
  fixedByReplyMeta: false,
  threwWhileRecording: false,
  divergingFields: [],
  scriptsAbsentResultReply: false,
  paramsMismatch: null,
  refusalReleasedStream: false
}

/** What the ten scenarios that script an `undefined`-valued param look like when the bridge drops it. */
const droppedUndefinedKey: BridgedParityEvidence = {
  ...base,
  threwWhileRecording: true,
  paramsMismatch: {
    step: 'linear.listIssues#1',
    undefinedValuedKeys: ['.workspaceId'],
    differingKeys: ['.workspaceId']
  }
}

describe('the bridged-parity flag', () => {
  it('is the name the suite and the pin both spell', () => {
    expect(BRIDGED_PARITY_FLAG).toBe('RPC_FOUNDATION_BRIDGE')
  })

  it('skips on one value only, so an unset or mistyped variable still runs the gate', () => {
    expect(BRIDGED_PARITY_OFF).toBe('0')
    const skips = (value: string | undefined): boolean => value === BRIDGED_PARITY_OFF
    expect([undefined, '', '1', 'false', 'off'].filter(skips)).toEqual([])
    expect(skips('0')).toBe(true)
  })
})

describe('classifying one diverging golden', () => {
  it('names the missing field first, but only where supplying it was enough', () => {
    const absent = {
      ...base,
      scriptsAbsentResultReply: true,
      divergingFields: ['sender[0].settlement']
    }
    expect(classifyBridgedParity({ ...absent, fixedByReplyMeta: true })).toBe('reply-meta-required')
    expect(classifyBridgedParity(absent)).toBe('result-absent-settlement')
  })

  it('splits the absent-result partition by what moved first', () => {
    const absent = { ...base, scriptsAbsentResultReply: true }
    expect(
      classifyBridgedParity({ ...absent, divergingFields: ['sender[0].settlement', 'effects'] })
    ).toBe('result-absent-settlement')
    expect(classifyBridgedParity({ ...absent, divergingFields: ['effects'] })).toBe(
      'result-absent-observation'
    )
    expect(classifyBridgedParity({ ...absent, divergingFields: ['checkpoints'] })).toBe(
      'result-absent-observation'
    )
  })

  it('names a throw only when every param that moved is one the scenario valued `undefined`', () => {
    expect(classifyBridgedParity(droppedUndefinedKey)).toBe('params-undefined')
    expect(classifyBridgedParity({ ...base, threwWhileRecording: true })).toBe('unclassified')
  })

  it('refuses the class to a run where something else moved in the same params', () => {
    // A seeded wire bug — one extra own key on every request's params — throws the same message
    // inside the same ten scenarios. A rule that asked only whether the scenario scripts an
    // `undefined` key called all 33 of them this class and reported none of them.
    expect(
      classifyBridgedParity({
        ...droppedUndefinedKey,
        paramsMismatch: {
          step: 'linear.listIssues#1',
          undefinedValuedKeys: ['.workspaceId'],
          differingKeys: ['.seeded', '.workspaceId']
        }
      })
    ).toBe('unclassified')
  })

  it('refuses the class to a throw that moved no param at all', () => {
    expect(
      classifyBridgedParity({
        ...droppedUndefinedKey,
        paramsMismatch: {
          step: 'linear.listIssues#1',
          undefinedValuedKeys: ['.workspaceId'],
          differingKeys: []
        }
      })
    ).toBe('unclassified')
  })

  it('names a throw that came of the page releasing a stream it refused a frame on', () => {
    const released = {
      ...base,
      threwWhileRecording: true,
      scriptsAbsentResultReply: true,
      refusalReleasedStream: true
    }
    expect(classifyBridgedParity(released)).toBe('result-absent-stream-release')
    // Without the injected partition there is nothing to refuse, so a release is somebody's bug.
    expect(classifyBridgedParity({ ...released, scriptsAbsentResultReply: false })).toBe(
      'unclassified'
    )
    // A stream released with no refusal behind it is not this class either.
    expect(classifyBridgedParity({ ...released, refusalReleasedStream: false })).toBe(
      'unclassified'
    )
  })

  it('names the ordinal class ahead of the partition a matrix golden also carries', () => {
    expect(classifyBridgedParity({ ...base, divergingFields: ['sender[0].ordinal'] })).toBe(
      'write-ordinal'
    )
    expect(
      classifyBridgedParity({
        ...base,
        scriptsAbsentResultReply: true,
        divergingFields: ['payloads[0].ordinal', 'effects']
      })
    ).toBe('write-ordinal')
  })

  it('refuses to name a golden that diverged in no field at all', () => {
    expect(classifyBridgedParity(base)).toBe('unclassified')
  })
})

describe('what the pin still admits', () => {
  const classes = Object.keys(BRIDGED_PARITY_BASELINE).filter(
    (name): name is BridgedParityClass => name !== 'identical'
  )

  it('gives every class it still counts a reason, and every closed one none', () => {
    const reasoned = classes.filter((name) => BRIDGED_PARITY_EXCLUSIONS[name] !== undefined)
    const counted = classes.filter((name) => BRIDGED_PARITY_BASELINE[name] > 0)
    expect([...reasoned].sort()).toEqual([...counted].sort())
  })

  it('accounts for every golden in the corpus, once each', () => {
    // What ties the numbers to the corpus they describe. Each is pinned exactly, but only to a
    // number in this file; the sum being the size of the goldens directory is what says the pin
    // covers every golden, once each, rather than a subset the run happened to reach.
    const goldens = readdirSync(resolve(import.meta.dirname, '../../../rpc-foundation/goldens'))
    const counted = Object.values(BRIDGED_PARITY_BASELINE).reduce((sum, count) => sum + count, 0)
    expect({ counted }).toEqual({
      counted: goldens.filter((name) => name.endsWith('.json')).length
    })
  })

  it('names the goldens in a class small enough to name, and as many as it counts', () => {
    const nameable = classes.filter(
      (name) =>
        BRIDGED_PARITY_BASELINE[name] > 0 &&
        BRIDGED_PARITY_BASELINE[name] <= BRIDGED_PARITY_NAMEABLE
    )
    expect(nameable.length).toBeGreaterThan(0)
    for (const name of nameable) {
      const pinned = BRIDGED_PARITY_MEMBERS[name] ?? []
      expect({ [name]: pinned.length }).toEqual({ [name]: BRIDGED_PARITY_BASELINE[name] })
      expect({ [name]: new Set(pinned).size }).toEqual({ [name]: pinned.length })
    }
  })

  /** The membership a run that diverges exactly as the pin says would hand the rule. */
  function asPinned(): Map<string, readonly string[]> {
    const run = new Map<string, readonly string[]>()
    for (const name of classes) {
      const pinned = BRIDGED_PARITY_MEMBERS[name]
      if (pinned !== undefined) {
        run.set(name, pinned)
      }
    }
    return run
  }

  it('holds such a class to which goldens are in it, not only to how many', () => {
    // The trade a count cannot see: every predicate reads the scenario rather than the frame the
    // page refused — `scriptsAbsentResultReply` asks whether the scenario scripts the injected
    // shape anywhere — so a real refusal in a stream golden lands in an excluded class. Let one
    // golden leave as it arrives and the count, the sum and the `identical` pin all hold.
    expect(bridgedParityMembershipDrift(asPinned())).toEqual([])
    const pinned = BRIDGED_PARITY_MEMBERS['write-ordinal'] ?? []
    const traded = asPinned()
    traded.set('write-ordinal', [...pinned.slice(1), 'matrix-regressed-golden-1-1'])
    const drift = bridgedParityMembershipDrift(traded)
    expect(drift.length).toBe(1)
    expect(drift[0]).toContain('matrix-regressed-golden-1-1')
    expect(drift[0]).toContain(pinned[0])
  })

  it('says nothing about a class too large for the run to name', () => {
    const run = asPinned()
    run.set('result-absent-settlement', ['whatever-diverged'])
    expect(bridgedParityMembershipDrift(run)).toEqual([])
  })

  /** The tally a run that lands exactly on the pin hands the rule. */
  function asCounted(): BridgedParityTally {
    const counts: Record<BridgedParityClass, number> = {
      'reply-meta-required': 0,
      'result-absent-settlement': 0,
      'result-absent-observation': 0,
      'result-absent-stream-release': 0,
      'params-undefined': 0,
      'write-ordinal': 0,
      unclassified: 0
    }
    for (const name of classes) {
      counts[name] = BRIDGED_PARITY_BASELINE[name]
    }
    return { identical: BRIDGED_PARITY_BASELINE.identical, counts }
  }

  it('says nothing about the run the numbers were taken from', () => {
    expect(bridgedParityTallyDrift(asCounted())).toEqual([])
  })

  it('goes red on a golden that stopped diverging, which every other check lets through', () => {
    // The direction the rest of the suite cannot see. One `result-absent-settlement` golden
    // reported `identical` instead: nothing is unclassified, every diverging golden is still in an
    // excluded class, and the corpus is still 787. Only these two numbers moved.
    const tally = asCounted()
    const moved: BridgedParityTally = {
      identical: tally.identical + 1,
      counts: {
        ...tally.counts,
        'result-absent-settlement': tally.counts['result-absent-settlement'] - 1
      }
    }
    const drift = bridgedParityTallyDrift(moved)
    expect(drift.length).toBe(2)
    expect(drift.join('\n')).toContain(
      `identical: pinned ${tally.identical}, ran ${moved.identical}`
    )
    expect(drift.join('\n')).toContain('result-absent-settlement: pinned 341, ran 340')
  })

  it('goes red on a class that grew and on the corpus losing a golden', () => {
    const tally = asCounted()
    expect(
      bridgedParityTallyDrift({
        ...tally,
        counts: { ...tally.counts, unclassified: 1 }
      })
    ).toEqual(['unclassified: pinned 0, ran 1'])
    // A golden whose `it` threw before it was counted anywhere: the run is a golden short.
    expect(bridgedParityTallyDrift({ ...tally, identical: tally.identical - 1 })).toEqual([
      `identical: pinned ${tally.identical}, ran ${tally.identical - 1}`
    ])
  })

  it('leaves nothing for the reader to close: the `_meta` class is zero', () => {
    expect(BRIDGED_PARITY_BASELINE['reply-meta-required']).toBe(0)
    expect(BRIDGED_PARITY_EXCLUSIONS['reply-meta-required']).toBeUndefined()
  })
})
