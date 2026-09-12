import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type * as SecureFile from '../../shared/secure-file'
import { SshRelayResetIntentStore } from './ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from './ssh-relay-reset-retirement-record'

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof NodeFs>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})
vi.mock('../../shared/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return { ...actual, writeDurableSecureJsonFile: vi.fn(actual.writeDurableSecureJsonFile) }
})
const directories: string[] = []
afterEach(async () => {
  const fs = await vi.importActual<typeof NodeFs>('node:fs')
  const secure = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
  vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync)
  vi.mocked(writeDurableSecureJsonFile).mockImplementation(secure.writeDurableSecureJsonFile)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-reset-retired-'))
  directories.push(directory)
  const store = new SshRelayResetIntentStore(directory)
  const intent = await store.persist({
    version: 1,
    targetId: 'target',
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    endpoint: {
      relayDir: '/relay',
      runtimePath: '/bun',
      runtimeKind: 'bun',
      sockPath: '/socket',
      credentialFile: '/credential',
      relayPlatform: 'linux-x64'
    },
    request: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const selection = await store.persistSelection(intent, {
    version: 1,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: randomUUID(),
    retiredAt: 1,
    leases: [],
    routes: []
  })
  const receipt = await store.persistReceipt(intent, {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'runtime',
      prepared: true
    }
  })
  await store.persistCompletion(
    intent,
    {
      version: 1,
      intentSha256: receipt.intentSha256,
      selectionSha256: receipt.selectionSha256,
      receiptSha256: sshRelayResetRecordDigest(receipt),
      localRetired: true
    },
    () => {}
  )
  const archive = await store.archiveCompleted(intent, () => {})
  const head = join(directory, `${createHash('sha256').update(intent.targetId).digest('hex')}.json`)
  const next = {
    ...intent,
    request: { ...intent.request, operationId: 'next', runtimeIncarnation: 'next-runtime' }
  }
  return { directory, store, intent, selection, archive, head, next }
}

it('publishes retirement before clearing sidecars and admits a fresh intent without losing the archive', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  expect(f.store.read('target')).toBeNull()
  expect(existsSync(`${f.head}.selection`)).toBe(true)
  expect(f.store.readRetiredArchive(f.intent)).toEqual(f.archive)
  await expect(f.store.persist(f.intent)).rejects.toThrow('already_retired')
  await expect(f.store.persistSelection(f.intent, f.selection)).rejects.toThrow('binding_changed')
  const reopened = new SshRelayResetIntentStore(f.directory)
  await reopened.persist(f.next)
  expect(reopened.read('target')).toEqual(f.next)
  expect(reopened.readSelection(f.next)).toBeNull()
  expect(reopened.readArchive(f.intent)).toEqual(f.archive)
  await expect(f.store.persist(f.intent)).rejects.toThrow('conflict')
})

it.each(['before', 'after'])(
  'recovers a %s-marker-write failure by reflushing exact retirement',
  async (point) => {
    const f = await fixture()
    const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
    vi.mocked(writeDurableSecureJsonFile).mockImplementation((path, value) => {
      if (path === `${f.head}.retired`) {
        if (point === 'after') {
          actual.writeDurableSecureJsonFile(path, value)
        }
        throw new Error('marker write uncertain')
      }
      return actual.writeDurableSecureJsonFile(path, value)
    })
    await expect(f.store.retireArchived(f.intent, () => {})).rejects.toThrow(
      'marker write uncertain'
    )
    expect(f.store.read('target')).toEqual(point === 'after' ? null : f.intent)
    vi.mocked(writeDurableSecureJsonFile).mockImplementation(actual.writeDurableSecureJsonFile)
    await expect(f.store.retireArchived(f.intent, () => {})).resolves.toEqual(f.archive)
    expect(f.store.readRetiredArchive(f.intent)).toEqual(f.archive)
  }
)

it('resumes partial sidecar cleanup from the marker after reopening the store', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  const fs = await vi.importActual<typeof NodeFs>('node:fs')
  vi.mocked(unlinkSync).mockImplementation((path) => {
    if (path === `${f.head}.receipt`) {
      throw new Error('cleanup interrupted')
    }
    return fs.unlinkSync(path)
  })
  await expect(f.store.persist(f.next)).rejects.toThrow('cleanup interrupted')
  expect(existsSync(`${f.head}.selection`)).toBe(false)
  expect(existsSync(`${f.head}.receipt`)).toBe(true)
  expect(f.store.read('target')).toBeNull()
  vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync)
  const reopened = new SshRelayResetIntentStore(f.directory)
  await reopened.persist(f.next)
  expect(reopened.read('target')).toEqual(f.next)
  expect(reopened.readArchive(f.intent)).toEqual(f.archive)
})

it.each(['before', 'after'])(
  'recovers %s new-head publication without resurrecting the old operation',
  async (point) => {
    const f = await fixture()
    await f.store.retireArchived(f.intent, () => {})
    const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
    vi.mocked(writeDurableSecureJsonFile).mockImplementation((path, value) => {
      if (path === f.head) {
        if (point === 'after') {
          actual.writeDurableSecureJsonFile(path, value)
        }
        throw new Error('new intent write uncertain')
      }
      return actual.writeDurableSecureJsonFile(path, value)
    })
    await expect(f.store.persist(f.next)).rejects.toThrow('new intent write uncertain')
    expect(f.store.read('target')).toEqual(point === 'after' ? f.next : null)
    vi.mocked(writeDurableSecureJsonFile).mockImplementation(actual.writeDurableSecureJsonFile)
    await f.store.persist(f.next)
    expect(f.store.readSelection(f.next)).toBeNull()
    expect(f.store.readArchive(f.intent)).toEqual(f.archive)
  }
)

it('validates all remaining sidecars before removing any of them', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  const selected = readFileSync(`${f.head}.selection`, 'utf8')
  writeFileSync(`${f.head}.completion`, '{}')
  await expect(f.store.persist(f.next)).rejects.toThrow('archived_sidecar_changed')
  expect(readFileSync(`${f.head}.selection`, 'utf8')).toBe(selected)
  expect(f.store.readArchive(f.intent)).toEqual(f.archive)
})

it('refuses missing active head rather than deriving new authority from a marker', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  unlinkSync(f.head)
  expect(() => f.store.read('target')).toThrow('retired_head_missing')
  await expect(f.store.persist(f.next)).rejects.toThrow('retired_head_missing')
})

it('refuses orphaned sidecars when the active head disappeared without a retirement marker', async () => {
  const f = await fixture()
  unlinkSync(f.head)
  await expect(f.store.persist(f.next)).rejects.toThrow('orphaned_records')
  expect(existsSync(`${f.head}.selection`)).toBe(true)
})

it('does not use a retirement marker whose archive is missing to discard remaining records', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  unlinkSync(`${f.head}.archive-${sshRelayResetRecordDigest(f.intent)}`)
  expect(() => f.store.read('target')).toThrow('archive_unconfirmed')
  await expect(f.store.persist(f.next)).rejects.toThrow('archive_unconfirmed')
  expect(existsSync(`${f.head}.selection`)).toBe(true)
})

it('allows a later completed generation to replace the marker while retaining both archives', async () => {
  const f = await fixture()
  await f.store.retireArchived(f.intent, () => {})
  const next = await f.store.persist(f.next)
  const selection = await f.store.persistSelection(next, {
    ...f.selection,
    intentSha256: sshRelayResetRecordDigest(next)
  })
  const receipt = await f.store.persistReceipt(next, {
    ...f.archive.receipt,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'next',
      runtimeIncarnation: 'next-runtime',
      prepared: true
    }
  })
  await f.store.persistCompletion(
    next,
    {
      version: 1,
      intentSha256: receipt.intentSha256,
      selectionSha256: receipt.selectionSha256,
      receiptSha256: sshRelayResetRecordDigest(receipt),
      localRetired: true
    },
    () => {}
  )
  const archive = await f.store.archiveCompleted(next, () => {})
  await f.store.retireArchived(next, () => {})
  expect(f.store.read('target')).toBeNull()
  expect(f.store.readRetiredArchive(next)).toEqual(archive)
  expect(f.store.readArchive(f.intent)).toEqual(f.archive)
})
