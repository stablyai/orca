import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  statSync,
  realpathSync,
  mkdirSync,
  copyFileSync,
  readFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PtyOwnershipTransferAdmissionRecord } from './pty-ownership-transfer-admission-record'
import * as durable from '../../durable-file-write'
import * as secureFile from '../../../shared/secure-file'
import type { OrcadManagedStopAuthority } from '../../../shared/orcad-managed-stop-authority'

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-admission-record-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('reopens the exact profile fence and leaves other profiles untouched', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  expect(record.isClosed()).toBe(false)
  record.close()
  expect(new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').isClosed()).toBe(true)
  expect(
    new PtyOwnershipTransferAdmissionRecord(join(directory, 'other'), 'runtime').isClosed()
  ).toBe(false)
  expect(() =>
    new PtyOwnershipTransferAdmissionRecord(directory, 'other-runtime').isClosed()
  ).toThrow('record_invalid')
  const write = vi.spyOn(durable, 'writeFileDurableSync')
  record.close()
  expect(write).not.toHaveBeenCalled()
  if (process.platform !== 'win32') {
    expect(statSync(join(directory, 'pty-ownership-transfer-admission.json')).mode & 0o777).toBe(
      0o600
    )
  }
})

it.each([
  '',
  '{',
  '{"version":2,"runtimeId":"runtime","state":"closed"}',
  '{"version":1,"runtimeId":"runtime","state":"unknown"}',
  'x'.repeat(4097),
  `{"version":1,"runtimeId":"runtime","state":"closed"}${' '.repeat(32768)}`
])('does not interpret malformed fence data as open (%#)', (contents) => {
  writeFileSync(join(directory, 'pty-ownership-transfer-admission.json'), contents)
  expect(() => new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').isClosed()).toThrow()
})

it('durably reopens and can fence the same profile again', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  record.close()
  record.reopenAfterConfirmedNativeRefusal()
  expect(new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').isClosed()).toBe(false)
  record.close()
  expect(new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').isClosed()).toBe(true)
})

it('reflushes a close whose write succeeded before reporting failure', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  const write = durable.writeFileDurableSync
  const persist = vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('durability unconfirmed')
  })
  expect(() => record.close()).toThrow('durability unconfirmed')
  expect(record.isClosed()).toBe(true)
  record.close()
  expect(persist).toHaveBeenCalledTimes(2)
  record.close()
  expect(persist).toHaveBeenCalledTimes(2)
})

function authority(): OrcadManagedStopAuthority {
  return {
    runtimeId: 'runtime',
    profileId: 'profile',
    profileRoot: realpathSync(directory),
    transactionId: '11111111-1111-4111-8111-111111111111'
  }
}

it('only attests a durably acknowledged closed fence owned by the exact transaction', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  const owner = authority()
  expect(() => record.assertClosedFor(owner)).toThrow('closure_unverifiable')
  const write = durable.writeFileDurableSync
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('durability unconfirmed')
  })
  expect(() => record.close(owner)).toThrow('durability unconfirmed')
  expect(() => record.assertClosedFor(owner)).toThrow('closure_unverifiable')
  record.close(owner)
  expect(() => record.assertClosedFor(owner)).not.toThrow()
  expect(() =>
    record.assertClosedFor({
      ...owner,
      transactionId: '22222222-2222-4222-8222-222222222222'
    })
  ).toThrow('closure_unverifiable')
  record.reopenAfterConfirmedNativeRefusal(owner)
  expect(() => record.assertClosedFor(owner)).toThrow('closure_unverifiable')
})

it('does not reinterpret a downgraded bound record as a legacy fence', () => {
  const owner = authority()
  const path = join(directory, 'pty-ownership-transfer-admission.json')
  new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').close(owner)
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...saved, version: 1 }))
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  expect(() => record.isClosed()).toThrow('record_invalid')
  expect(() => record.close()).toThrow('record_invalid')
  expect(() => record.reopenAfterConfirmedNativeRefusal()).toThrow('record_invalid')
})

it('only attests reopening owned by the exact transaction, never absence or legacy openness', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  const owner = authority()
  expect(() => record.assertOpenFor(owner)).toThrow('reopening_unverifiable')
  record.close()
  record.reopenAfterConfirmedNativeRefusal()
  expect(() => record.assertOpenFor(owner)).toThrow('reopening_unverifiable')
  record.close(owner)
  expect(() => record.assertOpenFor(owner)).toThrow('reopening_unverifiable')
  record.reopenAfterConfirmedNativeRefusal(owner)
  expect(() => record.assertOpenFor(owner)).not.toThrow()
  expect(() => record.assertOpenFor({ ...owner, profileId: 'other' })).toThrow(
    'reopening_unverifiable'
  )
  const successor = { ...owner, transactionId: '22222222-2222-4222-8222-222222222222' }
  expect(() => record.assertOpenFor(successor)).toThrow('reopening_unverifiable')
  record.close(successor)
  record.reopenAfterConfirmedNativeRefusal(successor)
  expect(() => record.assertOpenFor(owner)).toThrow('reopening_unverifiable')
  expect(() => record.assertOpenFor(successor)).not.toThrow()
})

it('does not attest a readable reopening after an unconfirmed write', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  const owner = authority()
  record.close(owner)
  const write = durable.writeFileDurableSync
  vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('durability unconfirmed')
  })
  expect(() => record.reopenAfterConfirmedNativeRefusal(owner)).toThrow('durability unconfirmed')
  expect(record.isClosed()).toBe(false)
  expect(() => record.assertOpenFor(owner)).toThrow('reopening_unverifiable')
  record.reopenAfterConfirmedNativeRefusal(owner)
  expect(() => record.assertOpenFor(owner)).not.toThrow()
})

it.each(['closed', 'open'] as const)(
  'retains uncertainty when %s directory flush fails',
  (state) => {
    const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
    const owner = authority()
    if (state === 'open') {
      record.close(owner)
    }
    const flush = vi
      .spyOn(secureFile, 'bestEffortFsyncDirectorySync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('directory I/O failure'), { code: 'EIO' })
      })
    const write = () =>
      state === 'closed' ? record.close(owner) : record.reopenAfterConfirmedNativeRefusal(owner)
    const attest = () =>
      state === 'closed' ? record.assertClosedFor(owner) : record.assertOpenFor(owner)
    expect(write).toThrow('directory I/O failure')
    expect(attest).toThrow('unverifiable')
    expect(() =>
      record.close({ ...owner, transactionId: '22222222-2222-4222-8222-222222222222' })
    ).toThrow('authority_mismatch')
    write()
    expect(flush).toHaveBeenCalledTimes(2)
    expect(attest).not.toThrow()
  }
)

it('requires exact authority across restart and does not permit legacy callers to adopt it', () => {
  const owner = authority()
  new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').close(owner)
  const reopened = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  expect(reopened.isClosed()).toBe(true)
  reopened.close(owner)
  const wrongTransaction = { ...owner, transactionId: '22222222-2222-4222-8222-222222222222' }
  for (const invalid of [undefined, wrongTransaction, { ...owner, profileId: 'other' }]) {
    expect(() => reopened.close(invalid)).toThrow('authority_mismatch')
    expect(() => reopened.reopenAfterConfirmedNativeRefusal(invalid)).toThrow('authority_mismatch')
  }
  reopened.reopenAfterConfirmedNativeRefusal(owner)
  expect(new PtyOwnershipTransferAdmissionRecord(directory, 'runtime').isClosed()).toBe(false)
  expect(() => reopened.close()).toThrow('authority_mismatch')
  reopened.close(wrongTransaction)
  expect(() => reopened.reopenAfterConfirmedNativeRefusal(owner)).toThrow('authority_mismatch')
})

it('rejects a copied fence in another physical root even with the same runtime identity', () => {
  const owner = authority()
  const source = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  source.close(owner)
  const other = join(directory, 'other')
  mkdirSync(other)
  const destination = new PtyOwnershipTransferAdmissionRecord(other, 'runtime')
  expect(() => destination.close(owner)).toThrow('record_invalid')
  copyFileSync(
    join(directory, 'pty-ownership-transfer-admission.json'),
    join(other, 'pty-ownership-transfer-admission.json')
  )
  expect(() => destination.isClosed()).toThrow('record_invalid')
  expect(() => new PtyOwnershipTransferAdmissionRecord(directory, 'wrong').isClosed()).toThrow(
    'record_invalid'
  )
  expect(() => source.close({ ...owner, profileRoot: join(directory, '..') })).toThrow(
    'record_invalid'
  )
})

it('does not adopt or reopen a legacy closed fence but can close a legacy open record', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  record.close()
  expect(() => record.close(authority())).toThrow('authority_unverifiable')
  expect(() => record.reopenAfterConfirmedNativeRefusal(authority())).toThrow(
    'authority_unverifiable'
  )
  record.reopenAfterConfirmedNativeRefusal()
  record.close(authority())
  const saved = JSON.parse(
    readFileSync(join(directory, 'pty-ownership-transfer-admission.json'), 'utf8')
  )
  expect(saved).toMatchObject({ version: 2, authority: authority(), state: 'closed' })
})

it('reflushes bound writes after uncertain durability without admitting another transaction', () => {
  const record = new PtyOwnershipTransferAdmissionRecord(directory, 'runtime')
  const owner = authority()
  const write = durable.writeFileDurableSync
  const persist = vi.spyOn(durable, 'writeFileDurableSync').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('durability unconfirmed')
  })
  expect(() => record.close(owner)).toThrow('durability unconfirmed')
  expect(() =>
    record.close({ ...owner, transactionId: '22222222-2222-4222-8222-222222222222' })
  ).toThrow('authority_mismatch')
  record.close(owner)
  expect(persist).toHaveBeenCalledTimes(2)
  persist.mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('durability unconfirmed')
  })
  expect(() => record.reopenAfterConfirmedNativeRefusal(owner)).toThrow('durability unconfirmed')
  expect(() =>
    record.close({ ...owner, transactionId: '22222222-2222-4222-8222-222222222222' })
  ).toThrow('authority_mismatch')
  record.reopenAfterConfirmedNativeRefusal(owner)
  expect(persist).toHaveBeenCalledTimes(4)
})
