import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest as digest } from '../ssh/ssh-relay-reset-retirement-record'
import { SSH_RESET_CLIENT_INCARNATION } from './pty/provider/ssh-reset-route-retirement'
import { getPtyRouteRefusal } from './pty/provider/pty-route-refusal'
import { ptyOwnership } from './pty/provider/ownership-state'
import { createCompletedSshResetRecovery } from './ssh-reset-completed-recovery'
import {
  captureProfileLifetimeParticipation,
  type ProfileLifetimeParticipation
} from '../ssh/profile-lifetime-participation'
import { SshRelayResetRecordFiles } from '../ssh/ssh-relay-reset-record-files'
import type * as ProfileLifetimeAdmission from '../ssh/profile-lifetime-admission'

const nativeParticipation = vi.hoisted(() => vi.fn<() => ProfileLifetimeParticipation | null>())
vi.mock('../ssh/profile-lifetime-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof ProfileLifetimeAdmission>()),
  readCurrentProfileLifetimeParticipation: nativeParticipation
}))

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  nativeParticipation.mockReset()
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

async function fixture(
  options: { receipt?: boolean; completion?: boolean; sameClient?: boolean } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-completed-reset-recovery-'))
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }))
  const records = new SshRelayResetIntentStore(directory)
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: randomUUID(),
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
  await records.persist(intent)
  const appPtyId = toAppSshPtyId(intent.targetId, 'pty')
  cleanups.push(() => {
    ptyOwnership.delete(appPtyId)
  })
  const selection = await records.persistSelection(intent, {
    version: 1,
    intentSha256: digest(intent),
    clientIncarnation: options.sameClient ? SSH_RESET_CLIENT_INCARNATION : randomUUID(),
    retiredAt: 100,
    leases: [],
    routes: [{ appPtyId, incarnationId: randomUUID(), providerGeneration: 123 }]
  })
  if (options.receipt !== false) {
    const receipt = await records.persistReceipt(intent, {
      version: 1,
      intentSha256: digest(intent),
      selectionSha256: digest(selection),
      acknowledgment: {
        version: 1,
        operationId: 'reset',
        runtimeIncarnation: 'daemon',
        prepared: true
      }
    })
    if (options.completion !== false) {
      await records.persistCompletion(
        intent,
        {
          version: 1,
          intentSha256: digest(intent),
          selectionSha256: digest(selection),
          receiptSha256: digest(receipt),
          localRetired: true
        },
        () => {}
      )
    }
  }
  const assertLeaseRetired = vi.fn(() => {})
  const leases = {
    retireSshRemotePtyLeaseSelection: vi.fn(async () => ({ assertRetired: assertLeaseRetired }))
  }
  const assertAuthority = vi.fn(() => {})
  const assertResourcesAbsent = vi.fn(() => {})
  const assertExclusiveProfile = vi.fn(() => {})
  const releaseReservation = vi.fn((assertRetired: () => void) => {
    assertRetired()
  })
  const recoveryOptions = {
    intent,
    records,
    leases,
    assertAuthority,
    assertResourcesAbsent,
    assertExclusiveProfile,
    releaseReservation
  }
  return { ...recoveryOptions, recoveryOptions, selection, appPtyId, directory, assertLeaseRetired }
}

it('revalidates historical completion, fences absent routes and durably retires before release', async () => {
  const f = await fixture()
  f.releaseReservation.mockImplementation((assertRetired) => {
    assertRetired()
    expect(new SshRelayResetIntentStore(f.directory).read(f.intent.targetId)).toBeNull()
    expect(getPtyRouteRefusal(f.appPtyId)?.kind).toBe('relay-reset')
  })
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  const archive = await recovery.run(new AbortController().signal)
  expect(archive.completion.localRetired).toBe(true)
  expect(f.leases.retireSshRemotePtyLeaseSelection).toHaveBeenCalledWith(f.intent.targetId, [], 100)
  expect(f.releaseReservation).toHaveBeenCalledTimes(1)
})

it.each(['current', 'missing', 'lost-during-retirement'] as const)(
  'uses root-bound native successor evidence through completion: %s',
  async (mode) => {
    const f = await fixture()
    const root = realpathSync.native(f.directory)
    writeFileSync(join(root, 'profile-lifetime.lock'), '')
    const historical = captureProfileLifetimeParticipation(root, randomUUID(), () => {})
    nativeParticipation.mockReturnValue({ ...historical, processIncarnation: randomUUID() })
    const sidecars = join(root, 'ssh-reset-profile-participation')
    const path = new SshRelayResetRecordFiles(sidecars).path(digest(f.intent))
    if (mode !== 'missing') {
      mkdirSync(sidecars)
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          intentSha256: digest(f.intent),
          selectionSha256: digest(f.selection),
          clientIncarnation: f.selection.clientIncarnation,
          participation: historical
        })
      )
    }
    if (mode === 'lost-during-retirement') {
      f.leases.retireSshRemotePtyLeaseSelection.mockImplementation(async () => {
        rmSync(path)
        return { assertRetired: f.assertLeaseRetired }
      })
    }
    const { assertExclusiveProfile: unused, ...base } = f.recoveryOptions
    const operation = createCompletedSshResetRecovery({ ...base, profileRoot: root })
    if (mode === 'current') {
      await expect(operation.run(new AbortController().signal)).resolves.toMatchObject({
        completion: { localRetired: true }
      })
      expect(f.releaseReservation).toHaveBeenCalledOnce()
    } else {
      await expect(operation.run(new AbortController().signal)).rejects.toThrow('participation_')
      expect(f.releaseReservation).not.toHaveBeenCalled()
      if (mode === 'missing') {
        expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
      }
    }
    expect(unused).not.toHaveBeenCalled()
  }
)

it.each(['receipt', 'completion'] as const)(
  'refuses missing %s without writes or retirement',
  async (missing) => {
    const f = await fixture({ [missing]: false })
    const persist = vi.spyOn(f.records, 'persist')
    await expect(async () =>
      createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
    ).rejects.toThrow()
    expect(persist).not.toHaveBeenCalled()
    expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
    expect(f.releaseReservation).not.toHaveBeenCalled()
  }
)

it('refuses same-process selections requiring the retained operation', async () => {
  const f = await fixture({ sameClient: true })
  await expect(async () =>
    createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
  ).rejects.toThrow()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
})

it.each(['assertResourcesAbsent', 'assertExclusiveProfile', 'assertAuthority'] as const)(
  'refuses failed %s before writing',
  async (proof) => {
    const f = await fixture()
    f[proof].mockImplementation(() => {
      throw new Error('proof unavailable')
    })
    const persist = vi.spyOn(f.records, 'persist')
    await expect(async () =>
      createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
    ).rejects.toThrow('proof unavailable')
    expect(persist).not.toHaveBeenCalled()
    expect(f.releaseReservation).not.toHaveBeenCalled()
  }
)

it('refuses a replacement route before lease retirement', async () => {
  const f = await fixture()
  ptyOwnership.set(f.appPtyId, f.intent.targetId)
  await expect(async () =>
    createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
  ).rejects.toThrow()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
  expect(ptyOwnership.get(f.appPtyId)).toBe(f.intent.targetId)
})

it.each([
  'persist',
  'persistSelection',
  'persistReceipt',
  'persistCompletion',
  'archiveCompleted',
  'retireArchived'
] as const)('retries uncertain %s without releasing admission early', async (method) => {
  const f = await fixture()
  vi.spyOn(f.records, method).mockRejectedValueOnce(new Error('write uncertain'))
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  await expect(recovery.run(new AbortController().signal)).rejects.toThrow('write uncertain')
  expect(f.releaseReservation).not.toHaveBeenCalled()
  await expect(recovery.run(new AbortController().signal)).resolves.toMatchObject({
    completion: { localRetired: true }
  })
  expect(f.releaseReservation).toHaveBeenCalledTimes(1)
})

it('retries a retirement-marker failure after publication', async () => {
  const f = await fixture()
  const retire = f.records.retireArchived.bind(f.records)
  vi.spyOn(f.records, 'retireArchived').mockImplementationOnce(async (...args) => {
    await retire(...args)
    throw new Error('marker return uncertain')
  })
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  await expect(recovery.run(new AbortController().signal)).rejects.toThrow(
    'marker return uncertain'
  )
  expect(f.records.read(f.intent.targetId)).toBeNull()
  expect(f.releaseReservation).not.toHaveBeenCalled()
  await expect(recovery.run(new AbortController().signal)).resolves.toMatchObject({
    completion: { localRetired: true }
  })
})

it('retains finalization on release failure and retries release', async () => {
  const f = await fixture()
  f.releaseReservation.mockImplementationOnce(() => {
    throw new Error('release uncertain')
  })
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  await expect(recovery.run(new AbortController().signal)).rejects.toThrow('release uncertain')
  expect(f.records.read(f.intent.targetId)).toBeNull()
  await expect(recovery.run(new AbortController().signal)).resolves.toMatchObject({
    completion: { localRetired: true }
  })
  expect(f.releaseReservation).toHaveBeenCalledTimes(2)
})

it('does not mutate after pre-aborted admission', async () => {
  const f = await fixture()
  const signal = AbortSignal.abort()
  const persist = vi.spyOn(f.records, 'persist')
  await expect(async () =>
    createCompletedSshResetRecovery(f.recoveryOptions).run(signal)
  ).rejects.toThrow()
  expect(persist).not.toHaveBeenCalled()
  expect(f.releaseReservation).not.toHaveBeenCalled()
})

it('retries with a fresh signal after cancellation following marker publication', async () => {
  const f = await fixture()
  const abort = new AbortController()
  const retire = f.records.retireArchived.bind(f.records)
  vi.spyOn(f.records, 'retireArchived').mockImplementationOnce(async (...args) => {
    const archive = await retire(...args)
    abort.abort(new Error('cancelled after publication'))
    return archive
  })
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  await expect(recovery.run(abort.signal)).rejects.toThrow('cancelled after publication')
  expect(f.releaseReservation).not.toHaveBeenCalled()
  await expect(recovery.run(new AbortController().signal)).resolves.toMatchObject({
    completion: { localRetired: true }
  })
})

it.each(['assertResourcesAbsent', 'assertExclusiveProfile'] as const)(
  'rechecks %s after asynchronous lease retirement',
  async (proof) => {
    const f = await fixture()
    f.leases.retireSshRemotePtyLeaseSelection.mockImplementationOnce(async () => {
      f[proof].mockImplementation(() => {
        throw new Error('proof changed')
      })
      return { assertRetired: f.assertLeaseRetired }
    })
    const archive = vi.spyOn(f.records, 'archiveCompleted')
    await expect(
      createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
    ).rejects.toThrow('proof changed')
    expect(archive).not.toHaveBeenCalled()
    expect(f.releaseReservation).not.toHaveBeenCalled()
  }
)

it('coalesces concurrent callers and serves finalized retries without releasing twice', async () => {
  const f = await fixture()
  const recovery = createCompletedSshResetRecovery(f.recoveryOptions)
  const first = recovery.run(new AbortController().signal)
  expect(recovery.run(new AbortController().signal)).toBe(first)
  const archive = await first
  f.assertAuthority.mockImplementation(() => {
    throw new Error('reservation released')
  })
  await expect(recovery.run(new AbortController().signal)).resolves.toEqual(archive)
  expect(f.releaseReservation).toHaveBeenCalledTimes(1)
  expect(f.leases.retireSshRemotePtyLeaseSelection).toHaveBeenCalledTimes(1)
})

it('does not infer current retirement proof from a marker after another client restart', async () => {
  const f = await fixture()
  await createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
  f.releaseReservation.mockClear()
  f.leases.retireSshRemotePtyLeaseSelection.mockClear()
  await expect(
    createCompletedSshResetRecovery(f.recoveryOptions).run(new AbortController().signal)
  ).rejects.toThrow('retirement_proof_missing')
  expect(f.releaseReservation).not.toHaveBeenCalled()
  expect(f.leases.retireSshRemotePtyLeaseSelection).not.toHaveBeenCalled()
})
