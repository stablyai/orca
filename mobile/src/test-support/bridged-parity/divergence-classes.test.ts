import { describe, expect, it } from 'vitest'
import {
  classifyBridgedParity,
  BRIDGED_PARITY_BASELINE,
  BRIDGED_PARITY_EXCLUSIONS,
  BRIDGED_PARITY_FLAG,
  type BridgedParityClass,
  type BridgedParityEvidence
} from './divergence-classes'

const base: BridgedParityEvidence = {
  fixedByReplyMeta: false,
  threwWhileRecording: false,
  divergingFields: [],
  scriptsAbsentResultReply: false,
  paramsMismatch: null
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
  it('is the name the suite, the pin and the CI job all spell', () => {
    expect(BRIDGED_PARITY_FLAG).toBe('RPC_FOUNDATION_BRIDGE')
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

  it('leaves nothing for the reader to close: the `_meta` class is zero', () => {
    expect(BRIDGED_PARITY_BASELINE['reply-meta-required']).toBe(0)
    expect(BRIDGED_PARITY_EXCLUSIONS['reply-meta-required']).toBeUndefined()
  })
})
