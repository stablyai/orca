import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SshRelayResetIntentStore } from '../ssh/ssh-relay-reset-intent-store'
import { sshRelayResetRecordDigest } from '../ssh/ssh-relay-reset-retirement-record'
import {
  assertSshResetAdmissionAllowed,
  getSshResetIntentStore,
  getRetainedSshResetTargetIds,
  reserveSshResetCapture,
  sshResetOperationAuthorities
} from './ssh-reset-production-state'

const state = vi.hoisted(() => ({ directory: '' }))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: new Map() }))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => state.directory
}))

beforeEach(() => {
  state.directory = mkdtempSync(join(tmpdir(), 'orca-reset-admission-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.directory, { recursive: true, force: true })
})

async function persistIntent() {
  return getSshResetIntentStore().persist({
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
}

it('rediscovers durable intent without an active session, isolated by target', async () => {
  assertSshResetAdmissionAllowed('target')
  await persistIntent()
  expect(() => assertSshResetAdmissionAllowed('target')).toThrow('reconciliation_required')
  expect(() => assertSshResetAdmissionAllowed('other')).not.toThrow()
})

it('does not admit an orphaned selection when its active head disappears', async () => {
  const intent = await persistIntent()
  await getSshResetIntentStore().persistSelection(intent, {
    version: 1,
    intentSha256: sshRelayResetRecordDigest(intent),
    clientIncarnation: randomUUID(),
    retiredAt: 1,
    leases: [],
    routes: []
  })
  unlinkSync(
    join(
      state.directory,
      'ssh-relay-resets',
      `${createHash('sha256').update('target').digest('hex')}.json`
    )
  )
  expect(() => assertSshResetAdmissionAllowed('target')).toThrow('orphaned_records')
})

it('permits verified durable retirement only after the retained operation slot is released', async () => {
  const store = getSshResetIntentStore()
  const intent = await persistIntent()
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
  await store.archiveCompleted(intent, () => {})
  await store.retireArchived(intent, () => {})
  expect(store.read('target')).toBeNull()
  const retained = vi.spyOn(sshResetOperationAuthorities, 'get').mockReturnValue({} as never)
  expect(() => assertSshResetAdmissionAllowed('target')).toThrow('reconciliation_required')
  retained.mockRestore()
  expect(() => assertSshResetAdmissionAllowed('target')).not.toThrow()
})

it('propagates unreadable evidence instead of granting admission', () => {
  vi.spyOn(SshRelayResetIntentStore.prototype, 'read').mockImplementation(() => {
    throw new Error('unreadable')
  })
  expect(() => assertSshResetAdmissionAllowed('target')).toThrow('unreadable')
})

it('reserves synchronously and releases only its own unretained capture', () => {
  const reservation = reserveSshResetCapture('target')
  expect(getRetainedSshResetTargetIds()).toContain('target')
  expect(() => assertSshResetAdmissionAllowed('target')).toThrow('reconciliation_required')
  expect(() => reserveSshResetCapture('target')).toThrow('reconciliation_required')
  reservation.assertCurrent()
  reservation.release()
  const replacement = reserveSshResetCapture('target')
  expect(reservation.release).toThrow('reservation_changed')
  replacement.assertCurrent()
  replacement.release()
  expect(getRetainedSshResetTargetIds()).not.toContain('target')
})

it('cannot release capture while the controller authority remains retained', () => {
  const reservation = reserveSshResetCapture('target')
  const retained = vi.spyOn(sshResetOperationAuthorities, 'get').mockReturnValue({} as never)
  expect(reservation.release).toThrow('authority_still_retained')
  reservation.assertCurrent()
  retained.mockRestore()
  reservation.release()
})
