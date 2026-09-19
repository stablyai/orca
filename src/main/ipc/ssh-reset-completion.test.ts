import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { IPtyProvider } from '../providers/types'
import type { SshPtyLeaseOperations } from '../persistence/leasing-ssh-ptys/ssh-pty-lease-operations'
import { retireSshRemotePtyLeaseSelection } from '../persistence/leasing-ssh-ptys/ssh-pty-reset-retirement'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import { captureSshResetRetirementSelection } from './pty/provider/ssh-reset-selection-capture'
import { ptyOwnership, ptyIncarnationById } from './pty/provider/ownership-state'
import { sshProviders, sshProvidersByGeneration } from './pty/provider/registry'
import { ptySizes } from './pty/delivery/visibility-state'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { completePreparedSshRelayReset } from './ssh-reset-completion'

const cleanups: (() => void)[] = []
let generation = 2000000
afterEach(() => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-reset-completion-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const targetId = randomUUID()
  const id = toAppSshPtyId(targetId, 'pty')
  const providerGeneration = ++generation
  const provider = { providerGeneration } as unknown as IPtyProvider
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId,
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
      runtimeIncarnation: 'daemon',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  const operations: SshPtyLeaseOperations = {
    state: {
      sshRemotePtyLeases: [
        {
          targetId,
          ptyId: 'pty',
          state: 'attached',
          createdAt: 1,
          updatedAt: 2
        }
      ]
    } as PersistedState,
    toStoredPtyId: (_target, value) => value,
    toComparablePtyId: (_target, value) => value,
    clearBindingsForTarget: vi.fn(),
    clearBindingsForLeases: vi.fn(),
    flush: vi.fn(),
    flushDurableStateOrThrowAsync: vi.fn(async () => {})
  }
  sshProviders.set(targetId, provider)
  sshProvidersByGeneration.set(providerGeneration, provider)
  ptyOwnership.set(id, targetId)
  ptyIncarnationById.set(id, randomUUID())
  ptySizes.set(id, { cols: 80, rows: 24 })
  cleanups.push(() => {
    sshProviders.delete(targetId)
    sshProvidersByGeneration.delete(providerGeneration)
    ptyOwnership.delete(id)
    ptyIncarnationById.delete(id)
    ptySizes.delete(id)
  })
  const assertAuthority = vi.fn(() => {})
  const { selection } = captureSshResetRetirementSelection({
    intent,
    expectedProvider: provider,
    assertAuthority,
    retiredAt: 100,
    readLeases: () => operations.state.sshRemotePtyLeases!
  })
  const records = new SshRelayResetIntentStore(directory)
  await records.persist(intent)
  await records.persistSelection(intent, selection)
  const receipt = await records.persistReceipt(intent, {
    version: 1,
    intentSha256: selection.intentSha256,
    selectionSha256: sshRelayResetRecordDigest(selection),
    acknowledgment: {
      version: 1,
      operationId: 'reset',
      runtimeIncarnation: 'daemon',
      prepared: true
    }
  })
  const leases = {
    retireSshRemotePtyLeaseSelection: vi.fn(
      (target: string, selected: typeof selection.leases, retiredAt: number) =>
        retireSshRemotePtyLeaseSelection(operations, target, selected, retiredAt)
    )
  }
  const assertCapturedRetired = vi.fn(() => {})
  const teardownCaptured = vi.fn(async () => {
    expect(operations.state.sshRemotePtyLeases![0].state).toBe('expired')
    expect(ptyOwnership.has(id)).toBe(false)
    expect(ptySizes.has(id)).toBe(false)
    expect(records.readCompletion(intent)).toBeNull()
    return { assertRetired: assertCapturedRetired }
  })
  const options = {
    intent,
    records,
    leases,
    expectedProvider: provider,
    assertAuthority,
    teardownCaptured
  }
  return {
    options,
    intent,
    records,
    selection,
    receipt,
    operations,
    id,
    directory,
    leases,
    teardownCaptured,
    assertAuthority,
    assertCapturedRetired
  }
}

it('joins durable evidence, real lease/route retirement, captured teardown and completion', async () => {
  const f = await fixture()
  const completion = await completePreparedSshRelayReset(f.options)
  expect(completion.localRetired).toBe(true)
  expect(new SshRelayResetIntentStore(f.directory).readCompletion(f.intent)).toEqual(completion)
  expect(f.records.readReceipt(f.intent)).toEqual(f.receipt)
  f.teardownCaptured.mockImplementation(async () => ({ assertRetired: f.assertCapturedRetired }))
  await expect(completePreparedSshRelayReset(f.options)).resolves.toEqual(completion)
  expect(f.operations.flushDurableStateOrThrowAsync).toHaveBeenCalledTimes(2)
  expect(f.teardownCaptured).toHaveBeenCalledTimes(2)
})

it.each(['persist', 'persistSelection', 'persistReceipt'] as const)(
  'refuses an uncertain %s reflush before any retirement',
  async (method) => {
    const f = await fixture()
    vi.spyOn(f.records, method).mockRejectedValueOnce(new Error('uncertain preparation'))
    await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('uncertain preparation')
    expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
    expect(ptyOwnership.has(f.id)).toBe(true)
    expect(f.teardownCaptured).not.toHaveBeenCalled()
  }
)

it('refuses a replaced route before retiring structurally identical leases', async () => {
  const f = await fixture()
  ptyIncarnationById.set(f.id, randomUUID())
  await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('selection_changed')
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  expect(f.operations.state.sshRemotePtyLeases![0].state).toBe('attached')
  expect(f.teardownCaptured).not.toHaveBeenCalled()
})

it('stops after uncertain lease durability and retries the same retained selection', async () => {
  const f = await fixture()
  vi.mocked(f.operations.flushDurableStateOrThrowAsync).mockRejectedValueOnce(
    new Error('lease write')
  )
  await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('lease write')
  expect(ptyOwnership.has(f.id)).toBe(true)
  expect(f.teardownCaptured).not.toHaveBeenCalled()
  expect(f.records.readCompletion(f.intent)).toBeNull()
  await expect(completePreparedSshRelayReset(f.options)).resolves.toMatchObject({
    localRetired: true
  })
})

it.each(['lease', 'route', 'authority', 'captured'])(
  'refuses %s replacement during captured teardown without completion',
  async (change) => {
    const f = await fixture()
    f.teardownCaptured.mockImplementationOnce(async () => {
      if (change === 'lease') {
        f.operations.state.sshRemotePtyLeases![0].updatedAt = 999
      }
      if (change === 'route') {
        ptyIncarnationById.set(f.id, 'replacement')
      }
      if (change === 'authority') {
        f.assertAuthority.mockImplementation(() => {
          throw new Error('new authority')
        })
      }
      if (change === 'captured') {
        f.assertCapturedRetired.mockImplementation(() => {
          throw new Error('not retired')
        })
      }
      return { assertRetired: f.assertCapturedRetired }
    })
    await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow()
    expect(f.records.readCompletion(f.intent)).toBeNull()
    if (change === 'lease') {
      expect(f.operations.state.sshRemotePtyLeases![0].updatedAt).toBe(999)
    }
    if (change === 'route') {
      expect(ptyIncarnationById.get(f.id)).toBe('replacement')
    }
  }
)

it('retains proof after teardown failure and reflushes on retry', async () => {
  const f = await fixture()
  f.teardownCaptured.mockRejectedValueOnce(new Error('close uncertain'))
  await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('close uncertain')
  expect(f.records.readReceipt(f.intent)).toEqual(f.receipt)
  expect(f.records.readCompletion(f.intent)).toBeNull()
  await expect(completePreparedSshRelayReset(f.options)).resolves.toMatchObject({
    localRetired: true
  })
})

it('revalidates retained completion after a write succeeded but its return was lost', async () => {
  const f = await fixture()
  const persistCompletion = f.records.persistCompletion.bind(f.records)
  vi.spyOn(f.records, 'persistCompletion').mockImplementationOnce(async (...args) => {
    await persistCompletion(...args)
    throw new Error('lost completion return')
  })
  await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('lost completion return')
  expect(f.records.readCompletion(f.intent)?.localRetired).toBe(true)
  f.teardownCaptured.mockImplementation(async () => ({ assertRetired: f.assertCapturedRetired }))
  await expect(completePreparedSshRelayReset(f.options)).resolves.toMatchObject({
    localRetired: true
  })
  f.operations.state.sshRemotePtyLeases![0].updatedAt = 999
  await expect(completePreparedSshRelayReset(f.options)).rejects.toThrow('selection_changed')
  expect(f.teardownCaptured).toHaveBeenCalledTimes(2)
})
