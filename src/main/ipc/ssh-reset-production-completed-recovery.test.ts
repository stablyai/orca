import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest as digest } from '../ssh/ssh-relay-reset-retirement-record'
import { runProductionCompletedSshResetRecovery } from './ssh-reset-production-completed-recovery'
import {
  assertSshResetAdmissionAllowed,
  getRetainedSshResetTargetIds,
  getSshResetIntentStore
} from './ssh-reset-production-state'
import type { captureSshResetRecoveryResourceGuard } from './ssh-reset-recovery-resource-guard'

const f = vi.hoisted(() => ({
  root: '',
  resets: new Map<string, Promise<void>>(),
  sessions: new Map(),
  allowed: vi.fn(),
  shutdown: vi.fn(),
  profile: vi.fn(),
  retainProfile: vi.fn(),
  capture: vi.fn(),
  resources: vi.fn(),
  retire: vi.fn()
}))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => f.root
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: f.sessions }))
vi.mock('./ssh-connect-attempt-registry', () => ({
  assertSshConnectsNotFenced: f.shutdown,
  resetRelayInFlight: f.resets
}))
vi.mock('./ssh-target-destruction-admission', () => ({
  assertSshTargetNotManagedOrPreparing: f.allowed
}))
vi.mock('./ssh-reset-successor-profile-authority', () => ({
  retainSshResetSuccessorProfileAuthority: f.retainProfile
}))
vi.mock('./ssh-reset-recovery-resource-guard', () => ({
  captureSshResetRecoveryResourceGuard: f.capture
}))

beforeEach(() => {
  vi.resetAllMocks()
  f.root = realpathSync.native(mkdtempSync(join(tmpdir(), 'orca-production-reset-recovery-')))
  f.retainProfile.mockReturnValue(f.profile)
  f.retire.mockResolvedValue({ assertRetired: vi.fn() })
  f.capture.mockImplementation(
    (options: Parameters<typeof captureSshResetRecoveryResourceGuard>[0]) => ({
      leases: { retireSshRemotePtyLeaseSelection: f.retire },
      assertCurrent: () => {
        options.assertReserved()
        const expected =
          typeof options.expectedReset === 'function'
            ? options.expectedReset()
            : options.expectedReset
        if (!expected || f.resets.get(options.intent.targetId) !== expected) {
          throw new Error('tracked_reset_changed')
        }
        f.resources()
      }
    })
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  f.resets.clear()
  f.sessions.clear()
  rmSync(f.root, { recursive: true, force: true })
})

async function fixture(completed = true) {
  const records = getSshResetIntentStore()
  const intent = parseSshRelayResetIntent({
    version: 1,
    targetId: randomUUID(),
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
      operationId: randomUUID(),
      runtimeIncarnation: 'daemon',
      ownerGeneration: 1,
      ownerLease: 'lease'
    }
  })
  await records.persist(intent)
  const selection = await records.persistSelection(intent, {
    version: 1,
    intentSha256: digest(intent),
    clientIncarnation: randomUUID(),
    retiredAt: 1,
    leases: [],
    routes: []
  })
  const receipt = await records.persistReceipt(intent, {
    version: 1,
    intentSha256: digest(intent),
    selectionSha256: digest(selection),
    acknowledgment: {
      version: 1,
      operationId: intent.request.operationId,
      runtimeIncarnation: 'daemon',
      prepared: true
    }
  })
  if (completed) {
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
  return {
    records,
    intent,
    run: (signal = new AbortController().signal) =>
      runProductionCompletedSshResetRecovery(intent.targetId, signal)
  }
}

it('publishes reservation and exact tracked promise before reentrant recovery, then releases durably', async () => {
  const t = await fixture()
  let reentrant: Promise<unknown> | undefined
  f.resources.mockImplementationOnce(() => {
    reentrant = t.run()
  })
  const first = t.run()
  expect(getRetainedSshResetTargetIds()).toContain(t.intent.targetId)
  expect(f.resets.has(t.intent.targetId)).toBe(true)
  expect(t.run()).toBe(first)
  expect(() => assertSshResetAdmissionAllowed(t.intent.targetId)).toThrow()
  await expect(first).resolves.toMatchObject({ completion: { localRetired: true } })
  expect(reentrant).toBe(first)
  expect(f.capture).toHaveBeenCalledOnce()
  expect(f.retire).toHaveBeenCalledOnce()
  expect(t.records.readRetiredArchive(t.intent)).not.toBeNull()
  expect(getRetainedSshResetTargetIds()).not.toContain(t.intent.targetId)
  expect(f.resets.has(t.intent.targetId)).toBe(false)
  assertSshResetAdmissionAllowed(t.intent.targetId)
})

it('refuses receipt-only recovery before creating a reservation', async () => {
  const t = await fixture(false)
  expect(t.run).toThrow()
  expect(getRetainedSshResetTargetIds()).not.toContain(t.intent.targetId)
  expect(f.capture).not.toHaveBeenCalled()
  expect(f.retire).not.toHaveBeenCalled()
})

it('refuses unavailable successor evidence before reserving', async () => {
  const t = await fixture()
  f.retainProfile.mockImplementation(() => {
    throw new Error('native proof missing')
  })
  expect(t.run).toThrow('native proof missing')
  expect(getRetainedSshResetTargetIds()).not.toContain(t.intent.targetId)
})

it('refuses an unrelated tracked reset without replacing it', async () => {
  const t = await fixture()
  const unrelated = Promise.resolve()
  f.resets.set(t.intent.targetId, unrelated)
  expect(t.run).toThrow('operation_still_live')
  expect(f.resets.get(t.intent.targetId)).toBe(unrelated)
  expect(getRetainedSshResetTargetIds()).not.toContain(t.intent.targetId)
})

it('retains failed resource validation and a fresh tracked promise without recapturing context', async () => {
  const t = await fixture()
  f.resources.mockImplementationOnce(() => {
    throw new Error('resources retained')
  })
  const first = t.run()
  const firstTracked = f.resets.get(t.intent.targetId)
  await expect(first).rejects.toThrow('resources retained')
  expect(getRetainedSshResetTargetIds()).toContain(t.intent.targetId)
  expect(f.retire).not.toHaveBeenCalled()
  const second = t.run()
  expect(f.resets.get(t.intent.targetId)).not.toBe(firstTracked)
  await expect(second).resolves.toMatchObject({ completion: { localRetired: true } })
  expect(f.capture).toHaveBeenCalledOnce()
  expect(f.retainProfile).toHaveBeenCalledOnce()
})

it('latches construction failure instead of recapturing replacement resources', async () => {
  const t = await fixture()
  f.capture.mockImplementationOnce(() => {
    throw new Error('context unavailable')
  })
  await expect(t.run()).rejects.toThrow('context unavailable')
  await expect(t.run()).rejects.toThrow('context unavailable')
  expect(f.capture).toHaveBeenCalledOnce()
  expect(f.retire).not.toHaveBeenCalled()
})

it('preserves an unrelated reset installed during a failed attempt', async () => {
  const t = await fixture()
  const unrelated = Promise.resolve()
  f.resources.mockImplementationOnce(() => {
    f.resets.set(t.intent.targetId, unrelated)
    throw new Error('overlapping reset')
  })
  await expect(t.run()).rejects.toThrow('overlapping reset')
  expect(f.resets.get(t.intent.targetId)).toBe(unrelated)
  expect(t.run).toThrow('operation_still_live')
})

it('retains original native authority across retries', async () => {
  const t = await fixture()
  f.resources.mockImplementationOnce(() => {
    throw new Error('resources retained')
  })
  await expect(t.run()).rejects.toThrow('resources retained')
  f.profile.mockImplementation(() => {
    throw new Error('native identity changed')
  })
  await expect(t.run()).rejects.toThrow('native identity changed')
  expect(f.retainProfile).toHaveBeenCalledOnce()
  expect(f.retire).not.toHaveBeenCalled()
})

it('rechecks completed evidence after queuing without replacing the original reservation', async () => {
  const t = await fixture()
  const first = t.run()
  const read = vi.spyOn(SshRelayResetIntentStore.prototype, 'readCompletion').mockReturnValue(null)
  await expect(first).rejects.toThrow()
  expect(getRetainedSshResetTargetIds()).toContain(t.intent.targetId)
  expect(f.retire).not.toHaveBeenCalled()
  read.mockRestore()
  await expect(t.run()).resolves.toMatchObject({ completion: { localRetired: true } })
  expect(f.retainProfile).toHaveBeenCalledOnce()
})

it('does not reserve for an already canceled observer', async () => {
  const t = await fixture()
  const observer = new AbortController()
  observer.abort(new Error('canceled'))
  expect(() => t.run(observer.signal)).toThrow('canceled')
  expect(getRetainedSshResetTargetIds()).not.toContain(t.intent.targetId)
})

it('preserves the reservation when cancellation arrives before queued execution', async () => {
  const t = await fixture()
  const observer = new AbortController()
  const first = t.run(observer.signal)
  observer.abort(new Error('canceled'))
  await expect(first).rejects.toThrow('canceled')
  expect(getRetainedSshResetTargetIds()).toContain(t.intent.targetId)
  expect(f.capture).not.toHaveBeenCalled()
  await expect(t.run()).resolves.toMatchObject({ completion: { localRetired: true } })
})
