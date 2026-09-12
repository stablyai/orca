import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferDestinationFileStore } from './pty-ownership-transfer-destination-file-store'
import { parseDelegatedInputState } from './pty-ownership-transfer-delegated-input-state'
import { parsePtyOwnershipTransferDestinationFile } from './pty-ownership-transfer-destination-file'
import {
  identity,
  request
} from '../../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
import * as durable from '../../durable-file-write'

let directory: string
let store: PtyOwnershipTransferDestinationFileStore
const claim = { version: 1, previousClaim: null, claim: { generation: 1, claimId: 'first' } }
const attempt = { kind: 'attempt' as const, epoch: 0, inputId: 'input', data: 'command' }
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-input-settlement-'))
  store = new PtyOwnershipTransferDestinationFileStore({ directory })
  store.prepare(identity, 0)
  store.bindDelegatedSource(identity, {
    version: 1,
    proof: request(),
    endpoint: '/incumbent.sock',
    incumbentVersion: 'test',
    endpointCredential: 'test'
  })
  store.reserveDelegatedClaimIntent(identity, null, claim)
  store.commit(identity, {
    bridgeId: identity.bridgeId,
    receiptId: 'receipt',
    acceptedSourceEndSeq: 0,
    committedAt: '2026-09-06T00:00:00Z'
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
const reopen = () => new PtyOwnershipTransferDestinationFileStore({ directory })

it('persists each settlement boundary and retirement intent in the existing destination file', () => {
  store.input.transitionDelegated(identity, attempt)
  expect(reopen().input.loadDelegated(identity)?.entries[0].phase).toBe('attempted')
  expect(() =>
    store.input.transitionDelegated(identity, { kind: 'settled', epoch: 0, inputId: 'input' })
  ).toThrow('unproven')
  store.input.transitionDelegated(identity, { kind: 'applied', epoch: 0, inputId: 'input' })
  expect(() =>
    store.input.transitionDelegated(identity, { kind: 'begin-retirement', epoch: 0 })
  ).toThrow('unsettled')
  store.input.transitionDelegated(identity, { kind: 'settled', epoch: 0, inputId: 'input' })
  store.input.transitionDelegated(identity, { kind: 'begin-retirement', epoch: 0 })
  expect(reopen().input.loadDelegated(identity)).toMatchObject({ epoch: 0, retiring: true })
  expect(() => reopen().input.transitionDelegated(identity, attempt)).toThrow('in_progress')
  reopen().input.transitionDelegated(identity, { kind: 'complete-retirement', epoch: 0 })
  expect(reopen().input.loadDelegated(identity)).toEqual({ epoch: 1, retiring: false, entries: [] })
  expect(() => store.input.transitionDelegated(identity, attempt)).toThrow('epoch_conflict')
})

it('rejects conflicting retries and does not downgrade settled evidence', () => {
  store.input.transitionDelegated(identity, attempt)
  expect(() =>
    store.input.transitionDelegated(identity, { ...attempt, data: 'different' })
  ).toThrow('payload_conflict')
  store.input.transitionDelegated(identity, { kind: 'applied', epoch: 0, inputId: 'input' })
  store.input.transitionDelegated(identity, { kind: 'settled', epoch: 0, inputId: 'input' })
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  store.input.transitionDelegated(identity, attempt)
  store.input.transitionDelegated(identity, { kind: 'applied', epoch: 0, inputId: 'input' })
  expect(write).not.toHaveBeenCalled()
  expect(store.input.loadDelegated(identity)?.entries[0].phase).toBe('settled')
})

it('retains attempts after a failed applied-state write', () => {
  store.input.transitionDelegated(identity, attempt)
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce(() => {
    throw new Error('disk failed')
  })
  expect(() =>
    store.input.transitionDelegated(identity, { kind: 'applied', epoch: 0, inputId: 'input' })
  ).toThrow('disk failed')
  expect(reopen().input.loadDelegated(identity)?.entries[0].phase).toBe('attempted')
})

it('keeps v4 settlement data across a new claim and rejects legacy input mutation', () => {
  store.input.transitionDelegated(identity, attempt)
  store.reserveDelegatedClaimIntent(identity, claim, {
    version: 1,
    previousClaim: claim.claim,
    claim: { generation: 2, claimId: 'second' }
  })
  expect(reopen().input.loadDelegated(identity)?.entries[0].data).toBe('command')
  expect(() => store.acceptInput(identity, 'legacy', 'command')).toThrow('requires_epoch')
})

it('refuses downgrade or omission of versioned settlement evidence', () => {
  store.input.transitionDelegated(identity, attempt)
  const record = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), 'utf8'))
  expect(record.version).toBe(4)
  expect(() => parsePtyOwnershipTransferDestinationFile({ ...record, version: 3 }, 10)).toThrow()
  expect(() =>
    parsePtyOwnershipTransferDestinationFile({ ...record, delegatedInputs: undefined }, 10)
  ).toThrow()
})

it('retries an after-write failure without losing or duplicating the durable attempt', () => {
  const write = durable.writeFileDurableSync
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('after write')
  })
  expect(() => store.input.transitionDelegated(identity, attempt)).toThrow('after write')
  expect(reopen().input.transitionDelegated(identity, attempt).entries).toEqual([
    { inputId: 'input', data: 'command', phase: 'attempted' }
  ])
})

it.each([
  { epoch: -1, retiring: false, entries: [] },
  { epoch: 0, retiring: true, entries: [] },
  { epoch: 0, retiring: true, entries: [{ inputId: 'a', data: 'x', phase: 'applied' }] },
  { epoch: 0, retiring: false, entries: [{ inputId: 'a', data: 'x', phase: 'unknown' }] }
])('rejects invalid persisted evidence %#', (record) => {
  expect(() => parseDelegatedInputState(record, 10)).toThrow()
})
