import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseSshRelayResetIntent } from '../ssh/ssh-relay-reset-intent'
import { sshRelayResetRecordDigest as digest } from '../ssh/ssh-relay-reset-retirement-record'
import {
  assertSshResetAdmissionAllowed,
  getRetainedSshResetTargetIds,
  getSshResetIntentStore,
  isSshResetAdmissionBlocked,
  reserveSshResetCapture,
  reserveSshResetRecovery,
  sshResetOperationAuthorities
} from './ssh-reset-production-state'

const state = vi.hoisted(() => ({ profile: '', sessions: new Map() }))
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => state.profile
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: state.sessions }))

let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-recovery-reservation-'))
  state.profile = directory
})
afterEach(() => {
  vi.restoreAllMocks()
  state.sessions.clear()
  rmSync(directory, { recursive: true, force: true })
})

function intentFixture() {
  return parseSshRelayResetIntent({
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
      runtimeIncarnation: 'incarnation',
      ownerGeneration: 1,
      ownerLease: 'secret'
    }
  })
}

async function selectedFixture() {
  const store = getSshResetIntentStore()
  const intent = await store.persist(intentFixture())
  const selection = await store.persistSelection(intent, {
    version: 1,
    intentSha256: digest(intent),
    clientIncarnation: 'previous-desktop',
    retiredAt: 100,
    leases: [],
    routes: []
  })
  const head = join(
    directory,
    'ssh-relay-resets',
    `${createHash('sha256').update(intent.targetId).digest('hex')}.json`
  )
  const retire = async () => {
    const receipt = await store.persistReceipt(intent, {
      version: 1,
      intentSha256: digest(intent),
      selectionSha256: digest(selection),
      acknowledgment: {
        version: 1,
        operationId: 'reset',
        runtimeIncarnation: 'incarnation',
        prepared: true
      }
    })
    await store.persistCompletion(
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
    await store.archiveCompleted(intent, () => {})
    await store.retireArchived(intent, () => {})
  }
  return { store, intent, selection, head, retire }
}

it('requires exact persisted intent and a selection before reserving', async () => {
  const intent = intentFixture()
  expect(() => reserveSshResetRecovery(intent)).toThrow('intent_changed')
  const store = getSshResetIntentStore()
  await store.persist(intent)
  expect(() => reserveSshResetRecovery({ ...intent, targetGeneration: 2 })).toThrow(
    'intent_changed'
  )
  expect(() => reserveSshResetRecovery(intent)).toThrow('selection_missing')
  expect(getRetainedSshResetTargetIds()).not.toContain(intent.targetId)
})

it('refuses a capture reservation even when durable selection is present', async () => {
  const intent = intentFixture()
  const capture = reserveSshResetCapture(intent.targetId)
  try {
    const store = getSshResetIntentStore()
    await store.persist(intent)
    await store.persistSelection(intent, {
      version: 1,
      intentSha256: digest(intent),
      clientIncarnation: 'previous',
      retiredAt: 100,
      leases: [],
      routes: []
    })
    expect(() => reserveSshResetRecovery(intent)).toThrow('operation_still_live')
  } finally {
    capture.release()
  }
})

it.each(['session', 'authority'])('refuses an existing %s', async (kind) => {
  const f = await selectedFixture()
  if (kind === 'session') {
    state.sessions.set(f.intent.targetId, {})
  } else {
    vi.spyOn(sshResetOperationAuthorities, 'get').mockReturnValue({} as never)
  }
  expect(() => reserveSshResetRecovery(f.intent)).toThrow('operation_still_live')
  expect(getRetainedSshResetTargetIds()).not.toContain(f.intent.targetId)
})

it('fences admission through durable retirement until exact reservation release', async () => {
  const f = await selectedFixture()
  const reservation = reserveSshResetRecovery(f.intent)
  expect(reservation.intent).toEqual(f.intent)
  expect(reservation.selection).toEqual(f.selection)
  expect(Object.isFrozen(reservation.intent)).toBe(true)
  expect(() => reservation.release()).toThrow('retirement_required')
  expect(() => reserveSshResetRecovery(f.intent)).toThrow('operation_still_live')
  expect(() => reserveSshResetCapture(f.intent.targetId)).toThrow('reconciliation_required')
  expect(isSshResetAdmissionBlocked(f.intent.targetId)).toBe(true)
  await f.retire()
  expect(f.store.read(f.intent.targetId)).toBeNull()
  reservation.assertCurrent()
  expect(getRetainedSshResetTargetIds()).toContain(f.intent.targetId)
  expect(() => assertSshResetAdmissionAllowed(f.intent.targetId)).toThrow('reconciliation_required')
  reservation.release()
  expect(isSshResetAdmissionBlocked(f.intent.targetId)).toBe(false)
  expect(getRetainedSshResetTargetIds()).not.toContain(f.intent.targetId)
  expect(() => reservation.assertCurrent()).toThrow('reservation_changed')
  expect(() => reservation.release()).toThrow('reservation_changed')
})

it.each(['profile', 'intent', 'selection', 'session', 'authority'])(
  'retains the reservation on %s drift',
  async (kind) => {
    const f = await selectedFixture()
    const reservation = reserveSshResetRecovery(f.intent)
    const file = kind === 'selection' ? `${f.head}.selection` : f.head
    const before = readFileSync(file, 'utf8')
    if (kind === 'profile') {
      state.profile = join(directory, 'other')
    }
    if (kind === 'intent') {
      writeFileSync(file, JSON.stringify({ ...f.intent, targetGeneration: 2 }))
    }
    if (kind === 'selection') {
      writeFileSync(file, JSON.stringify({ ...f.selection, retiredAt: 101 }))
    }
    if (kind === 'session') {
      state.sessions.set(f.intent.targetId, {})
    }
    if (kind === 'authority') {
      vi.spyOn(sshResetOperationAuthorities, 'get').mockReturnValue({} as never)
    }
    expect(() => reservation.assertCurrent()).toThrow()
    expect(() => reservation.release()).toThrow()
    expect(getRetainedSshResetTargetIds()).toContain(f.intent.targetId)
    expect(isSshResetAdmissionBlocked(f.intent.targetId)).toBe(true)
    state.profile = directory
    state.sessions.clear()
    vi.restoreAllMocks()
    writeFileSync(file, before)
    reservation.assertCurrent()
    await f.retire()
    reservation.release()
  }
)
