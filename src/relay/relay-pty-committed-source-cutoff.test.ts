import { expect, it } from 'vitest'
import { parseRelayPtyCommittedSourceCutoff } from './relay-pty-committed-source-cutoff'

const committed = {
  phase: 'committed',
  destinationDelegation: {},
  destinationOutputRetention: true,
  sourceOutputEndSeq: 9,
  commitReceipt: { acceptedSourceEndSeq: 2 }
}

it('keeps historical source coverage separate from later destination journal output', () => {
  expect(parseRelayPtyCommittedSourceCutoff(5, committed)).toBe(5)
  expect(parseRelayPtyCommittedSourceCutoff(5, { ...committed, sourceOutputEndSeq: 100 })).toBe(5)
})

it('does not infer a legacy cutoff from a receipt or current journal end', () => {
  expect(parseRelayPtyCommittedSourceCutoff(undefined, committed)).toBeUndefined()
})

it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '5', null, 1, 10])(
  'refuses invalid or inconsistent cutoff %j',
  (value) => {
    expect(() => parseRelayPtyCommittedSourceCutoff(value, committed)).toThrow('journal_invalid')
  }
)

it.each([
  { phase: 'prepared' },
  { phase: 'aborted' },
  { destinationDelegation: undefined },
  { destinationOutputRetention: false },
  { commitReceipt: undefined }
])('requires committed delegated retention evidence: %j', (patch) => {
  expect(() => parseRelayPtyCommittedSourceCutoff(5, { ...committed, ...patch })).toThrow(
    'journal_invalid'
  )
})
