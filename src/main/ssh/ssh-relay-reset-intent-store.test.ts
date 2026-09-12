import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import type * as SecureFile from '../../shared/secure-file'
import { SshRelayResetIntentStore } from './ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from './ssh-relay-reset-retirement-record'

vi.mock('../../shared/secure-file', async (original) => {
  const actual = await original<typeof SecureFile>()
  return { ...actual, writeDurableSecureJsonFile: vi.fn(actual.writeDurableSecureJsonFile) }
})

let directory: string
const intent = {
  version: 1,
  targetId: 'target',
  targetGeneration: 1,
  targetRoutingDigest: 'a'.repeat(64),
  clientInstanceId: 'client',
  serverBuildId: 'build',
  endpoint: {
    relayDir: '/relay',
    runtimePath: '/relay/bun',
    runtimeKind: 'bun',
    sockPath: '/relay/socket',
    credentialFile: '/relay/credential',
    relayPlatform: 'linux-x64'
  },
  request: {
    version: 1,
    operationId: 'reset',
    runtimeIncarnation: 'incarnation',
    ownerGeneration: 1,
    ownerLease: 'secret'
  }
}
const file = () =>
  join(directory, `${createHash('sha256').update(intent.targetId).digest('hex')}.json`)

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-intent-'))
  vi.mocked(writeDurableSecureJsonFile).mockClear()
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

it('persists canonical intent, reads it in another instance, and reflushes exact retries', async () => {
  const store = new SshRelayResetIntentStore(directory)
  expect(store.read('target')).toBeNull()
  const saved = await store.persist({ ...intent, ignored: true })
  expect(Object.isFrozen(saved)).toBe(true)
  expect(new SshRelayResetIntentStore(directory).read('target')).toEqual(saved)
  await store.persist(intent)
  expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(2)
})

it('preserves optional durable host recovery binding across store recreation', async () => {
  const store = new SshRelayResetIntentStore(directory)
  const preparation = {
    version: 1,
    journalDirectory: '/journal',
    principal: 'owner',
    authenticationKind: 'endpoint-credential',
    sockPath: intent.endpoint.sockPath,
    serverBuildId: intent.serverBuildId
  }
  const saved = await store.persist({ ...intent, preparation })
  expect(new SshRelayResetIntentStore(directory).read('target')).toEqual(saved)
  expect(saved.preparation).toEqual(preparation)
  expect(Object.isFrozen(saved.preparation)).toBe(true)
  await expect(
    store.persist({ ...intent, preparation: { ...preparation, principal: 'other' } })
  ).rejects.toThrow('conflict')
})

it('preserves immutable destination evidence across store recreation and refuses changes', async () => {
  const store = new SshRelayResetIntentStore(directory)
  const destination = {
    version: 1,
    transport: 'ssh2',
    host: 'resolved.example',
    port: 22,
    username: 'owner',
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
    proxyRouteDigest: 'b'.repeat(64)
  }
  const saved = await store.persist({ ...intent, destination: { ...destination, ignored: true } })
  expect(saved.destination).toEqual(destination)
  expect(Object.isFrozen(saved.destination)).toBe(true)
  expect(new SshRelayResetIntentStore(directory).read('target')).toEqual(saved)
  const before = readFileSync(file(), 'utf8')
  await expect(
    store.persist({ ...intent, destination: { ...destination, host: 'another.example' } })
  ).rejects.toThrow('conflict')
  expect(readFileSync(file(), 'utf8')).toBe(before)
})

it('does not add a destination field to legacy canonical intent', async () => {
  const saved = await new SshRelayResetIntentStore(directory).persist(intent)
  expect(JSON.stringify(saved)).toBe(JSON.stringify(intent))
  expect(saved).not.toHaveProperty('destination')
})

it('refuses a recovery binding for another endpoint before writing intent', async () => {
  const store = new SshRelayResetIntentStore(directory)
  await expect(
    store.persist({
      ...intent,
      preparation: {
        version: 1,
        journalDirectory: '/journal',
        principal: 'owner',
        authenticationKind: 'endpoint-credential',
        sockPath: '/other',
        serverBuildId: intent.serverBuildId
      }
    })
  ).rejects.toThrow('preparation_binding_changed')
  expect(store.read('target')).toBeNull()
})

it('refuses conflicting intent without replacing retained bytes', async () => {
  const store = new SshRelayResetIntentStore(directory)
  await store.persist(intent)
  const before = readFileSync(file(), 'utf8')
  await expect(store.persist({ ...intent, targetGeneration: 2 })).rejects.toThrow('conflict')
  expect(readFileSync(file(), 'utf8')).toBe(before)
  expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(1)
})

it.each(['corrupt', 'wrong-target', 'oversized'])('refuses %s evidence', async (mode) => {
  const store = new SshRelayResetIntentStore(directory)
  writeFileSync(
    file(),
    mode === 'corrupt'
      ? '{'
      : mode === 'oversized'
        ? ' '.repeat(65 * 1024)
        : JSON.stringify({ ...intent, targetId: 'another' })
  )
  expect(() => store.read('target')).toThrow()
  await expect(store.persist(intent)).rejects.toThrow()
  expect(writeDurableSecureJsonFile).not.toHaveBeenCalled()
})

it.each(['permission', 'before-write', 'after-write'])(
  'retains uncertainty after %s failure',
  async (mode) => {
    const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
    vi.mocked(writeDurableSecureJsonFile).mockImplementationOnce((path, value) => {
      if (mode === 'after-write') {
        actual.writeDurableSecureJsonFile(path, value)
      }
      if (mode === 'permission') {
        return false
      }
      throw new Error('injected write failure')
    })
    const store = new SshRelayResetIntentStore(directory)
    await expect(store.persist(intent)).rejects.toThrow()
    if (mode === 'after-write') {
      expect(store.read('target')).toEqual(intent)
    }
    await expect(store.persist(intent)).resolves.toEqual(intent)
    expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(2)
  }
)

it('refuses a cooperating writer holding the target lock and succeeds after release', async () => {
  const release = await lock(file(), { realpath: false, retries: 0 })
  const store = new SshRelayResetIntentStore(directory)
  try {
    await expect(store.persist(intent)).rejects.toThrow()
    expect(writeDurableSecureJsonFile).not.toHaveBeenCalled()
  } finally {
    await release()
  }
  await expect(store.persist(intent)).resolves.toEqual(intent)
})

it('isolates different profile directories', async () => {
  await new SshRelayResetIntentStore(directory).persist(intent)
  expect(new SshRelayResetIntentStore(join(directory, 'other')).read('target')).toBeNull()
})

async function selectedFixture() {
  const store = new SshRelayResetIntentStore(directory)
  const saved = await store.persist(intent)
  const selection = {
    version: 1,
    intentSha256: sshRelayResetRecordDigest(saved),
    clientIncarnation: 'desktop-process',
    retiredAt: 100,
    leases: [{ targetId: 'target', ptyId: 'pty-1', state: 'attached', createdAt: 1, updatedAt: 2 }],
    routes: [
      { appPtyId: 'ssh:target@@pty-1', incarnationId: 'pty-incarnation', providerGeneration: 1 }
    ]
  }
  return { store, saved, selection }
}

async function completedFixture() {
  const f = await selectedFixture()
  const selection = await f.store.persistSelection(f.saved, f.selection)
  const receipt = await f.store.persistReceipt(f.saved, {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'incarnation',
      prepared: true
    }
  })
  const completion = await f.store.persistCompletion(
    f.saved,
    {
      version: 1,
      intentSha256: receipt.intentSha256,
      selectionSha256: receipt.selectionSha256,
      receiptSha256: sshRelayResetRecordDigest(receipt),
      localRetired: true
    },
    () => {}
  )
  return { ...f, selection, receipt, completion }
}

it('archives a self-contained completed record set without altering active evidence', async () => {
  const f = await completedFixture()
  const before = readFileSync(file(), 'utf8')
  const archive = await f.store.archiveCompleted(f.saved, () => {})
  expect(archive).toEqual({
    version: 1,
    intent: f.saved,
    selection: f.selection,
    receipt: f.receipt,
    completion: f.completion
  })
  expect(Object.isFrozen(archive)).toBe(true)
  expect(readFileSync(file(), 'utf8')).toBe(before)
  expect(f.store.readCompletion(f.saved)).toEqual(f.completion)
  const reopened = new SshRelayResetIntentStore(directory)
  expect(reopened.readArchive(f.saved)).toEqual(archive)
  unlinkSync(file())
  expect(() => reopened.read(f.saved.targetId)).toThrow('orphaned_records')
  expect(reopened.readArchive(f.saved)).toEqual(archive)
})

it('refuses archive without completed records or current local retirement authority', async () => {
  const incomplete = await selectedFixture()
  await expect(incomplete.store.archiveCompleted(incomplete.saved, () => {})).rejects.toThrow()
  expect(incomplete.store.readArchive(incomplete.saved)).toBeNull()
  const f = await completedFixture()
  await expect(
    f.store.archiveCompleted(f.saved, () => {
      throw new Error('local retirement changed')
    })
  ).rejects.toThrow('local retirement changed')
  expect(f.store.readArchive(f.saved)).toBeNull()
})

it.each(['before-write', 'after-write', 'permissions'])(
  'reflushes an uncertain archive after %s',
  async (mode) => {
    const f = await completedFixture()
    const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
    vi.mocked(writeDurableSecureJsonFile).mockImplementationOnce((path, value) => {
      if (mode === 'after-write') {
        actual.writeDurableSecureJsonFile(path, value)
      }
      if (mode === 'permissions') {
        return false
      }
      throw new Error('archive write uncertain')
    })
    await expect(f.store.archiveCompleted(f.saved, () => {})).rejects.toThrow()
    expect(f.store.readCompletion(f.saved)).toEqual(f.completion)
    const writes = vi.mocked(writeDurableSecureJsonFile).mock.calls.length
    const archive = await f.store.archiveCompleted(f.saved, () => {})
    expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(writes + 1)
    expect(f.store.readArchive(f.saved)).toEqual(archive)
  }
)

it('uses one target lock for every active record and its archive', async () => {
  const f = await completedFixture()
  const release = await lock(file(), { realpath: false, retries: 0 })
  try {
    await expect(f.store.persistSelection(f.saved, f.selection)).rejects.toThrow()
    await expect(f.store.persistReceipt(f.saved, f.receipt)).rejects.toThrow()
    await expect(f.store.persistCompletion(f.saved, f.completion, () => {})).rejects.toThrow()
    await expect(f.store.archiveCompleted(f.saved, () => {})).rejects.toThrow()
  } finally {
    await release()
  }
  await expect(f.store.archiveCompleted(f.saved, () => {})).resolves.toMatchObject({
    completion: f.completion
  })
})

it('rejects archive corruption instead of replacing completed evidence', async () => {
  const f = await completedFixture()
  const archive = await f.store.archiveCompleted(f.saved, () => {})
  const archivePath = vi.mocked(writeDurableSecureJsonFile).mock.calls.at(-1)![0]
  writeFileSync(
    archivePath,
    JSON.stringify({ ...archive, completion: { ...archive.completion, localRetired: false } })
  )
  expect(() => f.store.readArchive(f.saved)).toThrow()
  await expect(f.store.archiveCompleted(f.saved, () => {})).rejects.toThrow()
  expect(f.store.readCompletion(f.saved)).toEqual(f.completion)
})

it('retains selection and bound receipt across instances and reflushes acknowledgment retries', async () => {
  const f = await selectedFixture()
  const selection = await f.store.persistSelection(f.saved, f.selection)
  const receipt = {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'incarnation',
      prepared: true
    }
  }
  await f.store.persistReceipt(f.saved, receipt)
  const reopened = new SshRelayResetIntentStore(directory)
  expect(reopened.readSelection(f.saved)).toEqual(selection)
  expect(reopened.readReceipt(f.saved)).toEqual(receipt)
  await reopened.persistReceipt(f.saved, receipt)
  expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(4)
})

it.each([
  'different-intent',
  'duplicate-lease',
  'duplicate-route',
  'normalized-lease',
  'other-target'
])('refuses invalid selection: %s', async (failure) => {
  const f = await selectedFixture()
  if (failure === 'different-intent') {
    f.selection.intentSha256 = 'b'.repeat(64)
  }
  if (failure === 'duplicate-lease') {
    f.selection.leases.push(f.selection.leases[0])
  }
  if (failure === 'duplicate-route') {
    f.selection.routes.push(f.selection.routes[0])
  }
  if (failure === 'normalized-lease') {
    Object.assign(f.selection.leases[0], { createdAt: undefined })
  }
  if (failure === 'other-target') {
    f.selection.leases[0].targetId = 'other'
  }
  await expect(f.store.persistSelection(f.saved, f.selection)).rejects.toThrow()
  expect(writeDurableSecureJsonFile).toHaveBeenCalledTimes(1)
})

it('refuses changed selection or receipt and retains acknowledgment after uncertain write', async () => {
  const f = await selectedFixture()
  const selection = await f.store.persistSelection(f.saved, f.selection)
  await expect(
    f.store.persistSelection(f.saved, { ...selection, clientIncarnation: 'other' })
  ).rejects.toThrow('conflict')
  const receipt = {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'incarnation',
      prepared: true
    }
  }
  await expect(
    f.store.persistReceipt(f.saved, { ...receipt, selectionSha256: 'b'.repeat(64) })
  ).rejects.toThrow('binding_invalid')
  const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
  vi.mocked(writeDurableSecureJsonFile).mockImplementationOnce((path, value) => {
    actual.writeDurableSecureJsonFile(path, value)
    throw new Error('after receipt write')
  })
  await expect(f.store.persistReceipt(f.saved, receipt)).rejects.toThrow('after receipt write')
  expect(f.store.readReceipt(f.saved)).toEqual(receipt)
  await expect(f.store.persistReceipt(f.saved, receipt)).resolves.toEqual(receipt)
})

it.each(['success', 'uncertain-write', 'authority-loss', 'post-write-loss', 'post-release-loss'])(
  'records completion only against retained preparation and retirement authority: %s',
  async (mode) => {
    const f = await selectedFixture()
    await expect(f.store.persistCompletion(f.saved, {}, vi.fn())).rejects.toThrow()
    const selection = await f.store.persistSelection(f.saved, f.selection)
    const receipt = await f.store.persistReceipt(f.saved, {
      version: 1,
      intentSha256: selection.intentSha256,
      selectionSha256: sshRelayResetRecordDigest(selection),
      acknowledgment: {
        version: 1,
        operationId: 'reset',
        runtimeIncarnation: 'incarnation',
        prepared: true
      }
    })
    const completion = {
      version: 1,
      intentSha256: receipt.intentSha256,
      selectionSha256: receipt.selectionSha256,
      receiptSha256: sshRelayResetRecordDigest(receipt),
      localRetired: true
    }
    const assertRetired = vi.fn()
    expect(f.store.readCompletion(f.saved)).toBeNull()
    await expect(
      f.store.persistCompletion(
        f.saved,
        { ...completion, receiptSha256: 'c'.repeat(64) },
        assertRetired
      )
    ).rejects.toThrow('binding_invalid')
    if (mode === 'authority-loss') {
      assertRetired.mockImplementationOnce(() => {
        throw new Error('replacement route')
      })
      await expect(f.store.persistCompletion(f.saved, completion, assertRetired)).rejects.toThrow(
        'replacement route'
      )
      expect(f.store.readCompletion(f.saved)).toBeNull()
    }
    if (mode === 'uncertain-write') {
      const actual = await vi.importActual<typeof SecureFile>('../../shared/secure-file')
      vi.mocked(writeDurableSecureJsonFile).mockImplementationOnce((path, value) => {
        actual.writeDurableSecureJsonFile(path, value)
        throw new Error('completion write uncertain')
      })
      await expect(f.store.persistCompletion(f.saved, completion, assertRetired)).rejects.toThrow(
        'completion write uncertain'
      )
      expect(f.store.readCompletion(f.saved)).toEqual(completion)
    }
    if (mode === 'post-write-loss' || mode === 'post-release-loss') {
      assertRetired.mockImplementationOnce(() => {})
      if (mode === 'post-release-loss') {
        assertRetired.mockImplementationOnce(() => {})
      }
      assertRetired.mockImplementationOnce(() => {
        throw new Error('retirement authority changed')
      })
      await expect(f.store.persistCompletion(f.saved, completion, assertRetired)).rejects.toThrow(
        'retirement authority changed'
      )
      // Retained bytes are recovery evidence, not permission to skip retirement revalidation.
      expect(f.store.readCompletion(f.saved)).toEqual(completion)
    }
    await expect(f.store.persistCompletion(f.saved, completion, assertRetired)).resolves.toEqual(
      completion
    )
    const reopened = new SshRelayResetIntentStore(directory)
    expect(reopened.readCompletion(f.saved)).toEqual(completion)
    await reopened.persistCompletion(f.saved, completion, assertRetired)
    expect(reopened.read(f.saved.targetId)).toEqual(f.saved)
    expect(reopened.readReceipt(f.saved)).toEqual(receipt)
  }
)
