import { expect, it } from 'vitest'
import { parseOrcadCompletedStopReceipt } from './orcad-completed-stop-receipt'
import { createOrcadDecommissionTransaction } from './orcad-activation-transaction'
import {
  emptyOrcadActivationRecord,
  withDecommissioningVersion,
  withDeactivatedVersion
} from './orcad-activation-record'

const before = {
  ...emptyOrcadActivationRecord(),
  active: '0.1.0+old',
  activatedAt: new Date(1).toISOString()
}
const accepted = withDecommissioningVersion(before, new Date(2))
const transactionId = '00000000-0000-4000-8000-000000000001'
const transaction = {
  ...createOrcadDecommissionTransaction({
    transactionId,
    authority: {
      runtimeId: 'runtime',
      profileId: 'profile',
      profileRoot: '/profile',
      transactionId
    },
    instance: { pid: 123, startedAtMs: null, nonce: 'original', lockPath: '/data/orcad.lock' },
    activeVersion: before.active,
    recordBefore: before,
    acceptedRecord: accepted,
    recordAfter: withDeactivatedVersion(accepted),
    now: new Date(2)
  }),
  phase: 'process-exited'
}

it('preserves the exact completed authority, original instance and record sides', () => {
  expect(parseOrcadCompletedStopReceipt(JSON.stringify(transaction))).toEqual({
    state: 'ok',
    transaction
  })
})
it.each([
  { phase: 'prepared' },
  { phase: 'admission-fenced' },
  { instance: undefined },
  { schemaVersion: 1, authority: undefined, instance: undefined },
  { recordAfter: accepted }
])('refuses incomplete or legacy proof %j', (change) => {
  expect(parseOrcadCompletedStopReceipt(JSON.stringify({ ...transaction, ...change })).state).toBe(
    'unreadable'
  )
})
it('distinguishes missing receipt from invalid data', () => {
  expect(parseOrcadCompletedStopReceipt(null)).toEqual({ state: 'absent' })
  expect(parseOrcadCompletedStopReceipt('{').state).toBe('unreadable')
})
