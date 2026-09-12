import { expect, it } from 'vitest'
import { readRelayPtyCaptureJournalSuffix } from './relay-pty-capture-journal-suffix'
import { identity } from './relay-pty-ownership-transfer-delegation-test-fixture'
import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'
import type { PtyOwnershipTransferOutputFrame } from '../shared/pty-ownership-transfer-wire'

function stateWith(frames: PtyOwnershipTransferOutputFrame[], nextSeq = 3) {
  return {
    histories: new Map([[identity.terminalId, { frames, nextSeq, retainedBytes: 0 }]])
  } as RelayPtyOwnershipTransferAdapterState
}

it('counts display units across journal slices without claiming raw delivery units', () => {
  const state = stateWith([
    { seq: 1, data: 'one🙂' },
    { seq: 2, data: 'two' }
  ])
  expect(readRelayPtyCaptureJournalSuffix(state, identity, 0, 2)).toEqual({
    throughSeq: 2,
    displayUnits: 8
  })
  expect(readRelayPtyCaptureJournalSuffix(state, identity, 1, 2)).toEqual({
    throughSeq: 2,
    displayUnits: 3
  })
})

it.each([
  [{ seq: 2, data: 'missing prefix' }],
  [
    { seq: 1, data: 'one' },
    { seq: 3, data: 'gap' }
  ],
  [
    { seq: 1, data: 'one' },
    { seq: 1, data: 'duplicate' }
  ],
  [
    { seq: 1, data: 'truncated', truncated: true },
    { seq: 2, data: 'two' }
  ]
])('refuses incomplete or ambiguous suffix frames: %j', (...frames) => {
  expect(() => readRelayPtyCaptureJournalSuffix(stateWith(frames), identity, 0, 2)).toThrow()
})

it('refuses a claimed journal end ahead of or behind retained history', () => {
  const state = stateWith([
    { seq: 1, data: 'one' },
    { seq: 2, data: 'two' }
  ])
  expect(() => readRelayPtyCaptureJournalSuffix(state, identity, 0, 3)).toThrow()
  expect(() => readRelayPtyCaptureJournalSuffix(state, identity, 0, 1)).toThrow()
})

it('accepts an empty journal suffix as zero display units, not proof of zero raw ingress', () => {
  expect(readRelayPtyCaptureJournalSuffix(stateWith([], 3), identity, 2, 2)).toEqual({
    throughSeq: 2,
    displayUnits: 0
  })
})
