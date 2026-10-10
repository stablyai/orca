import { describe, expect, it } from 'vitest'
import {
  parseOrcadActivationTransaction,
  planOrcadTransactionRecovery,
  serializeOrcadActivationTransaction
} from './orcad-activation-transaction'
import {
  committedOrcadDecommissionRecord,
  createOrcadDecommissionTransaction,
  withOrcadDecommissionProcessExited,
  withOrcadDecommissionStopDispatched
} from './orcad-decommission-transaction'
import { FakeOrcadHost, NEW } from './orcad-activation-host-test-harness'
import type { OrcadManagedStopRequest } from '../../shared/orcad-stop-request'

const T = new Date('2026-02-02T00:00:00.000Z')
const ID = '7f1c2a7e-6c1b-4a8e-9f0e-0a1b2c3d4e5f'
const before = { ...FakeOrcadHost.newRecord(), active: NEW }
const prepared = createOrcadDecommissionTransaction({
  transactionId: ID,
  recordBefore: before,
  now: T
})
const request: OrcadManagedStopRequest = {
  schemaVersion: 1,
  transactionId: ID,
  version: NEW,
  runtimeId: 'runtime-1',
  instance: { pid: 42, startedAtMs: 5, nonce: 'nonce', lockPath: '/home/u/.orca/orcad.lock' },
  retireIdleDaemon: true
}
const dispatched = withOrcadDecommissionStopDispatched(prepared, request, T)
const exited = withOrcadDecommissionProcessExited(dispatched, T)

describe('the decommission journal entry', () => {
  it('deactivates the active version and keeps it as previous', () => {
    expect(prepared.recordAfter).toMatchObject({ active: null, previous: NEW, snapshot: null })
  })

  it('journals a recordAfter released desktops still read, and commits the app version', () => {
    // Frozen copy of the check released desktops run on every stop journal they recover.
    const releasedDefect = (journal: typeof prepared): string | null => {
      const b = journal.recordBefore
      const deactivated = {
        schemaVersion: 1,
        active: null,
        previous: b.active,
        activatedAt: null,
        snapshot: null
      }
      return `${JSON.stringify(journal.recordAfter, null, 2)}\n` ===
        `${JSON.stringify(deactivated, null, 2)}\n`
        ? null
        : 'recordAfter is not the deactivated recordBefore'
    }
    const versionedBefore = { ...before, activeAppVersion: '1.5.0', rolledBackFrom: '0.9.0+ff01' }
    const versioned = createOrcadDecommissionTransaction({
      transactionId: ID,
      recordBefore: versionedBefore,
      now: T
    })
    const journal = JSON.parse(serializeOrcadActivationTransaction(versioned))
    expect(releasedDefect(journal)).toBeNull()
    const interrupted = withOrcadDecommissionProcessExited(
      withOrcadDecommissionStopDispatched(versioned, request, T),
      T
    )
    expect(planOrcadTransactionRecovery(interrupted, versionedBefore)).toMatchObject({
      action: 'confirm-decommissioned',
      record: { active: null, activeAppVersion: '1.5.0', rolledBackFrom: '0.9.0+ff01' }
    })
    expect(committedOrcadDecommissionRecord(versioned)).toMatchObject({
      previous: NEW,
      activeAppVersion: '1.5.0'
    })
  })

  it('round-trips every phase', () => {
    for (const transaction of [prepared, dispatched, exited]) {
      expect(
        parseOrcadActivationTransaction(serializeOrcadActivationTransaction(transaction))
      ).toEqual({ state: 'ok', transaction })
    }
  })

  it.each([
    ['a dispatched phase without its request', { ...dispatched, request: null }],
    ['a request before dispatch', { ...prepared, request }],
    [
      'a request for another transaction',
      {
        ...dispatched,
        request: { ...request, transactionId: '5a7e1f0c-3b2d-4e6f-9a8b-7c6d5e4f3a2b' }
      }
    ],
    [
      'a request for another version',
      { ...dispatched, request: { ...request, version: '0.9.0+ff01' } }
    ],
    ['a recordAfter that still serves', { ...prepared, recordAfter: before }]
  ])('reads %s as unreadable, keeping the fence', (_name, transaction) => {
    expect(parseOrcadActivationTransaction(JSON.stringify(transaction))).toMatchObject({
      state: 'unreadable'
    })
  })

  it('plans recovery from what the host is known to have done', () => {
    const after = prepared.recordAfter
    expect(planOrcadTransactionRecovery(prepared, before)).toEqual({
      action: 'keep-serving',
      version: NEW
    })
    expect(planOrcadTransactionRecovery(dispatched, before)).toEqual({
      action: 'resume-stop',
      request,
      record: after
    })
    expect(planOrcadTransactionRecovery(exited, before)).toEqual({
      action: 'confirm-decommissioned',
      version: NEW,
      record: after
    })
    expect(planOrcadTransactionRecovery(dispatched, after)).toEqual({
      action: 'confirm-decommissioned',
      version: NEW,
      record: null
    })
    expect(planOrcadTransactionRecovery(dispatched, { ...after, previous: null })).toMatchObject({
      action: 'refuse'
    })
  })
})
