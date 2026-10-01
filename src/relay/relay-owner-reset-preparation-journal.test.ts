import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as secure from '../shared/secure-file'
import { RelayOwnerResetPreparationJournal } from './relay-owner-reset-preparation-journal'

let directory: string
const request = {
  version: 1 as const,
  operationId: 'operation',
  runtimeIncarnation: 'runtime',
  ownerGeneration: 1,
  ownerLease: 'secret'
}
const store = () => new RelayOwnerResetPreparationJournal(directory, '/socket', 'build')
const persist = () => store().persist(request, 'principal', 'endpoint-credential', () => {})
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-preparation-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

it('advertises an absolute journal location without creating files', () => {
  const journal = new RelayOwnerResetPreparationJournal('relative-journal', '/socket', 'build')
  expect(journal.describe('owner', 'endpoint-credential')).toMatchObject({
    journalDirectory: resolve('relative-journal'),
    readerVersion: 1,
    principal: 'owner',
    sockPath: '/socket',
    serverBuildId: 'build'
  })
})

it('retains exact preparation across store recreation without claiming process exit', () => {
  expect(store().read(request)).toBeNull()
  persist()
  const record = store().read(request)
  expect(record).toEqual({
    version: 1,
    prepared: true,
    request,
    principal: 'principal',
    authenticationKind: 'endpoint-credential',
    sockPath: '/socket',
    serverBuildId: 'build'
  })
  expect(Object.isFrozen(record)).toBe(true)
  expect(Object.isFrozen(record!.request)).toBe(true)
  expect(readdirSync(directory)[0]).not.toContain('secret')
})

it('reflushes exact retry after a write published but its return was lost', () => {
  const write = secure.writeDurableSecureJsonFile
  const spy = vi
    .spyOn(secure, 'writeDurableSecureJsonFile')
    .mockImplementationOnce((path, record) => {
      write(path, record)
      throw new Error('return lost')
    })
  expect(persist).toThrow('return lost')
  expect(store().read(request)?.prepared).toBe(true)
  persist()
  expect(spy).toHaveBeenCalledTimes(2)
})

it('does not overwrite a conflicting principal or operation owner', () => {
  persist()
  const path = join(directory, readdirSync(directory)[0])
  const original = readFileSync(path, 'utf8')
  expect(() => store().persist(request, 'other', 'endpoint-credential', () => {})).toThrow(
    'conflict'
  )
  expect(() =>
    store().persist(
      { ...request, ownerLease: 'other' },
      'principal',
      'endpoint-credential',
      () => {}
    )
  ).toThrow('conflict')
  expect(readFileSync(path, 'utf8')).toBe(original)
})

it('refuses a different socket or build even with matching operation identifiers', () => {
  persist()
  expect(() =>
    new RelayOwnerResetPreparationJournal(directory, '/other', 'build').read(request)
  ).toThrow('conflict')
  expect(() =>
    new RelayOwnerResetPreparationJournal(directory, '/socket', 'other').read(request)
  ).toThrow('conflict')
})

it('does not grant preparation when the secure write cannot be confirmed', () => {
  vi.spyOn(secure, 'writeDurableSecureJsonFile').mockReturnValue(false)
  expect(persist).toThrow('write_unconfirmed')
  expect(store().read(request)).toBeNull()
})

it('preserves corrupt evidence rather than overwriting it on retry', () => {
  persist()
  const path = join(directory, readdirSync(directory)[0])
  writeFileSync(path, '{broken')
  expect(persist).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('{broken')
})

it('refuses reentrant publication through a second store instance', () => {
  const authority = () => expect(persist).toThrow('busy')
  store().persist(request, 'principal', 'endpoint-credential', authority)
  expect(store().read(request)?.prepared).toBe(true)
})

it('checks authority before any write and again after publication', () => {
  const write = vi.spyOn(secure, 'writeDurableSecureJsonFile')
  expect(() =>
    store().persist(request, 'principal', 'endpoint-credential', () => {
      throw new Error('stale')
    })
  ).toThrow('stale')
  expect(write).not.toHaveBeenCalled()
  let checks = 0
  expect(() =>
    store().persist(request, 'principal', 'endpoint-credential', () => {
      if (++checks === 3) {
        throw new Error('stale after write')
      }
    })
  ).toThrow('stale after write')
  expect(store().read(request)?.prepared).toBe(true)
})
