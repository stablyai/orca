import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import {
  assertOrcadStopNotCanceled,
  persistOrcadCanceledStopReceipt,
  readOrcadCanceledStopReceipt
} from './orcad-canceled-stop-receipt'

let home: string
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'orcad-canceled-stop-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})
function request() {
  return {
    schemaVersion: 1 as const,
    version: '0.1.0+test',
    authority: {
      runtimeId: 'runtime',
      profileId: 'profile',
      profileRoot: home,
      transactionId: '11111111-1111-4111-8111-111111111111'
    },
    instance: { pid: 123, startedAtMs: null, nonce: 'original', lockPath: join(home, 'orcad.lock') }
  }
}

it('retains exact cancellation outside transaction cleanup and reflushes retries', () => {
  const original = request()
  expect(readOrcadCanceledStopReceipt(home, original)).toBe(false)
  expect(() => assertOrcadStopNotCanceled(home, original.authority.transactionId)).not.toThrow()
  const write = vi.spyOn(secureFile, 'writeDurableSecureJsonFile')
  persistOrcadCanceledStopReceipt(home, original)
  expect(readOrcadCanceledStopReceipt(home, original)).toBe(true)
  expect(() => assertOrcadStopNotCanceled(home, original.authority.transactionId)).toThrow(
    'stop_canceled'
  )
  persistOrcadCanceledStopReceipt(home, original)
  expect(write).toHaveBeenCalledTimes(2)
  expect(() =>
    assertOrcadStopNotCanceled(home, '22222222-2222-4222-8222-222222222222')
  ).not.toThrow()
})

it.each(['version', 'instance', 'authority'] as const)(
  'never overwrites a conflicting %s',
  (field) => {
    const original = request()
    persistOrcadCanceledStopReceipt(home, original)
    const changed = {
      ...original,
      ...(field === 'version' ? { version: '0.2.0' } : {}),
      ...(field === 'instance' ? { instance: { ...original.instance, nonce: 'replacement' } } : {}),
      ...(field === 'authority' ? { authority: { ...original.authority, profileId: 'other' } } : {})
    }
    expect(() => persistOrcadCanceledStopReceipt(home, changed)).toThrow('receipt_mismatch')
    expect(readOrcadCanceledStopReceipt(home, original)).toBe(true)
  }
)

it('keeps malformed evidence blocking and refuses to overwrite it', () => {
  const original = request()
  persistOrcadCanceledStopReceipt(home, original)
  writeFileSync(
    join(home, '.orca-remote', 'orcad-canceled-stops', `${original.authority.transactionId}.json`),
    '{'
  )
  expect(() => assertOrcadStopNotCanceled(home, original.authority.transactionId)).toThrow(
    'stop_canceled'
  )
  expect(() => persistOrcadCanceledStopReceipt(home, original)).toThrow()
})

it('does not report successful persistence after a failed permission confirmation', () => {
  const original = request()
  vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockReturnValueOnce(false)
  expect(() => persistOrcadCanceledStopReceipt(home, original)).toThrow('permissions_unconfirmed')
})

it('reflushes after a write published evidence but failed durability confirmation', () => {
  const original = request()
  const write = secureFile.writeDurableSecureJsonFile
  vi.spyOn(secureFile, 'writeDurableSecureJsonFile').mockImplementationOnce((...args) => {
    write(...args)
    throw new Error('unconfirmed fsync')
  })
  expect(() => persistOrcadCanceledStopReceipt(home, original)).toThrow('unconfirmed fsync')
  expect(() => assertOrcadStopNotCanceled(home, original.authority.transactionId)).toThrow(
    'stop_canceled'
  )
  expect(() => persistOrcadCanceledStopReceipt(home, original)).not.toThrow()
})
