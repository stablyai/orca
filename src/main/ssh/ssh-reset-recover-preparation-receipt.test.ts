import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseSshRelayResetIntent } from './ssh-relay-reset-intent'
import { SshRelayResetIntentStore } from './ssh-relay-reset-intent-store'
import { readSshResetPreparation } from './ssh-relay-reset-read-preparation'
import { sshRelayResetRecordDigest } from './ssh-relay-reset-retirement-record'
import { recoverSshResetPreparationReceipt } from './ssh-reset-recover-preparation-receipt'

vi.mock('./ssh-relay-reset-read-preparation', () => ({ readSshResetPreparation: vi.fn() }))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-recovery-receipt-'))
  vi.mocked(readSshResetPreparation).mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

async function fixture() {
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: 'target',
    targetGeneration: 1,
    targetRoutingDigest: 'a'.repeat(64),
    clientInstanceId: 'client',
    serverBuildId: 'build',
    destination: {
      version: 1,
      transport: 'ssh2',
      host: 'host',
      port: 22,
      username: 'user',
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      proxyRouteDigest: 'a'.repeat(64)
    },
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
      operationId: 'operation',
      runtimeIncarnation: 'incarnation',
      ownerGeneration: 1,
      ownerLease: 'lease'
    },
    preparation: {
      version: 1,
      readerVersion: 1,
      journalDirectory: '/relay/journal',
      principal: 'owner',
      authenticationKind: 'endpoint-credential',
      sockPath: '/relay/socket',
      serverBuildId: 'build'
    }
  })
  const records = new SshRelayResetIntentStore(directory)
  await records.persist(intent)
  const selection = await records.persistSelection(intent, {
    version: 1,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: 'previous-client',
    retiredAt: 100,
    leases: [],
    routes: []
  })
  const preparation = {
    version: 1 as const,
    prepared: true as const,
    request: intent.request,
    principal: 'owner',
    authenticationKind: 'endpoint-credential' as const,
    sockPath: '/relay/socket',
    serverBuildId: 'build'
  }
  const assertCurrent = vi.fn()
  vi.mocked(readSshResetPreparation).mockResolvedValue({ preparation, assertCurrent })
  const abort = new AbortController()
  const assertAuthority = vi.fn()
  const connection = {
    exec: vi.fn(),
    usesSystemSshTransport: vi.fn(() => false),
    getExecutionDestination: vi.fn(() => intent.destination),
    getTransportGeneration: vi.fn(() => 1)
  }
  const options = { intent, records, connection, signal: abort.signal, assertAuthority }
  return {
    ...options,
    options,
    selection,
    preparation,
    assertCurrent,
    abort,
    recover: () => recoverSshResetPreparationReceipt(options)
  }
}

it('persists only canonical prepared evidence and reflushes it after store recreation', async () => {
  const f = await fixture()
  const receipt = await f.recover()
  expect(receipt).toEqual({
    version: 1,
    intentSha256: sshRelayResetRecordDigest(f.intent),
    selectionSha256: sshRelayResetRecordDigest(f.selection),
    acknowledgment: {
      version: 1,
      prepared: true,
      operationId: 'operation',
      runtimeIncarnation: 'incarnation'
    }
  })
  expect(f.assertCurrent).toHaveBeenCalledOnce()
  const records = new SshRelayResetIntentStore(directory)
  expect(records.readReceipt(f.intent)).toEqual(receipt)
  expect(records.readCompletion(f.intent)).toBeNull()
  expect(records.readArchive(f.intent)).toBeNull()
  const writes = [
    vi.spyOn(records, 'persist'),
    vi.spyOn(records, 'persistSelection'),
    vi.spyOn(records, 'persistReceipt')
  ]
  await expect(recoverSshResetPreparationReceipt({ ...f.options, records })).resolves.toEqual(
    receipt
  )
  for (const write of writes) {
    expect(write).toHaveBeenCalledOnce()
  }
  expect(readSshResetPreparation).toHaveBeenCalledOnce()
  expect(f.connection.exec).not.toHaveBeenCalled()
})

it.each(['missing', 'principal', 'operation', 'socket'])(
  'does not persist a receipt for %s journal evidence',
  async (kind) => {
    const f = await fixture()
    const preparation =
      kind === 'missing'
        ? null
        : {
            ...f.preparation,
            ...(kind === 'principal' ? { principal: 'other' } : {}),
            ...(kind === 'socket' ? { sockPath: '/other' } : {}),
            ...(kind === 'operation'
              ? { request: { ...f.intent.request, operationId: 'other' } }
              : {})
          }
    vi.mocked(readSshResetPreparation).mockResolvedValue({
      preparation,
      assertCurrent: f.assertCurrent
    })
    await expect(f.recover()).rejects.toThrow()
    expect(f.records.readReceipt(f.intent)).toBeNull()
    expect(f.records.read(f.intent.targetId)).toEqual(f.intent)
  }
)

it.each(['intent-missing', 'intent-changed', 'selection-missing', 'selection-changed'])(
  'refuses %s before reading the remote journal',
  async (kind) => {
    const f = await fixture()
    if (kind.startsWith('intent')) {
      vi.spyOn(f.records, 'read').mockReturnValue(
        kind.endsWith('missing') ? null : { ...f.intent, targetGeneration: 2 }
      )
    } else {
      vi.spyOn(f.records, 'readSelection').mockReturnValue(
        kind.endsWith('missing') ? null : { ...f.selection, intentSha256: 'b'.repeat(64) }
      )
    }
    await expect(f.recover()).rejects.toThrow()
    expect(readSshResetPreparation).not.toHaveBeenCalled()
  }
)

it.each(['intent', 'selection', 'authority', 'abort', 'destination'])(
  'refuses %s drift while the remote read is outstanding',
  async (kind) => {
    const f = await fixture()
    vi.mocked(readSshResetPreparation).mockImplementation(async () => {
      await Promise.resolve()
      if (kind === 'intent') {
        vi.spyOn(f.records, 'read').mockReturnValue(null)
      }
      if (kind === 'selection') {
        vi.spyOn(f.records, 'readSelection').mockReturnValue({ ...f.selection, retiredAt: 101 })
      }
      if (kind === 'authority') {
        f.assertAuthority.mockImplementation(() => {
          throw new Error('authority changed')
        })
      }
      if (kind === 'abort') {
        f.abort.abort(new Error('cancelled'))
      }
      if (kind === 'destination') {
        f.assertCurrent.mockImplementation(() => {
          throw new Error('destination changed')
        })
      }
      return { preparation: f.preparation, assertCurrent: f.assertCurrent }
    })
    const write = vi.spyOn(f.records, 'persistReceipt')
    await expect(f.recover()).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  }
)

it.each(['authority', 'abort'])('refuses %s before any remote read', async (kind) => {
  const f = await fixture()
  if (kind === 'abort') {
    f.abort.abort(new Error('cancelled'))
  } else {
    f.assertAuthority.mockImplementation(() => {
      throw new Error('authority changed')
    })
  }
  await expect(f.recover()).rejects.toThrow()
  expect(readSshResetPreparation).not.toHaveBeenCalled()
})

it.each(['persist', 'persistSelection', 'persistReceipt'] as const)(
  'rejects cancellation across the %s await even after durable publication',
  async (method) => {
    const f = await fixture()
    const original = f.records[method].bind(f.records)
    vi.spyOn(f.records, method).mockImplementationOnce(async (...args: unknown[]) => {
      const result = await (original as (...values: unknown[]) => Promise<unknown>)(...args)
      f.abort.abort(new Error('cancelled'))
      return result as never
    })
    await expect(f.recover()).rejects.toThrow('cancelled')
    expect(new SshRelayResetIntentStore(directory).read(f.intent.targetId)).toEqual(f.intent)
  }
)

it.each(['before', 'after'])(
  'retains retry evidence after a receipt write fails %s publication',
  async (when) => {
    const f = await fixture()
    const original = f.records.persistReceipt.bind(f.records)
    vi.spyOn(f.records, 'persistReceipt').mockImplementationOnce(async (...args) => {
      if (when === 'after') {
        await original(...args)
      }
      throw new Error('write failed')
    })
    await expect(f.recover()).rejects.toThrow('write failed')
    expect(f.records.read(f.intent.targetId)).toEqual(f.intent)
    expect(f.records.readSelection(f.intent)).toEqual(f.selection)
    const records = new SshRelayResetIntentStore(directory)
    expect(Boolean(records.readReceipt(f.intent))).toBe(when === 'after')
    await expect(
      recoverSshResetPreparationReceipt({ ...f.options, records })
    ).resolves.toHaveProperty('acknowledgment.prepared', true)
    expect(readSshResetPreparation).toHaveBeenCalledTimes(when === 'after' ? 1 : 2)
  }
)

it.each(['intent', 'selection'])(
  'rejects %s drift across persistence without publishing a receipt',
  async (kind) => {
    const f = await fixture()
    const persist = f.records.persist.bind(f.records)
    vi.spyOn(f.records, 'persist').mockImplementationOnce(async (value) => {
      const result = await persist(value)
      if (kind === 'intent') {
        vi.spyOn(f.records, 'read').mockReturnValue(null)
      } else {
        vi.spyOn(f.records, 'readSelection').mockReturnValue(null)
      }
      return result
    })
    const write = vi.spyOn(f.records, 'persistReceipt')
    await expect(f.recover()).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  }
)

it('refuses a write acknowledgment that does not confirm the exact canonical record', async () => {
  const f = await fixture()
  vi.spyOn(f.records, 'persist').mockResolvedValue({ ...f.intent, targetGeneration: 2 })
  await expect(f.recover()).rejects.toThrow('write_unconfirmed')
  expect(f.records.readReceipt(f.intent)).toBeNull()
})
