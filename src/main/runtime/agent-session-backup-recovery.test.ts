import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluateAgentSessionAcquisition } from '../../shared/agent-session-lease-adjudication'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionLeaseFixture } from '../../shared/agent-session-record.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import {
  agentSessionStorePath,
  loadAgentSessionStore,
  saveAgentSessionStore
} from './agent-session-record-store-file'

/** Reserve, observe the spawn, prove the handle: the only path to a `live` lease, whose invariant
 *  is that the head handle was minted at exactly the current fence. One store instance throughout,
 *  because reopening marks every lease unreconciled and refuses the next two steps. */
async function seedLiveSession(sessionId: string): Promise<number> {
  const store = await openStore()
  const reserved = await store.reserveOwner({
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'seed-live',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: 'seed-live' },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: NOW,
      spawnToken: 'seed-live'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId,
    fence,
    link: {
      linkId: 'link-live-1',
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW,
      handle: { provider: 'codex', threadId: `thread-${sessionId}` }
    },
    now: NOW
  })
  return fence
}

let root: string
let storePath: string

const NOW = 1_800_000_000_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-store-recovery-'))
  storePath = agentSessionStorePath(root)
  operations = 0
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function openStore(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
}

let operations = 0

function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

async function seedSession(sessionId: string): Promise<number> {
  const store = await openStore()
  const reserved = await store.reserveOwner({
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'seed',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: { callerKey: 'test', operationId: operationId(), fingerprint: 'seed' },
    now: NOW
  })
  return reserved.record.lease.runtimeFence
}

describe('crash-safe store writes', () => {
  it('never leaves the live path absent, and keeps a whole backup', async () => {
    await seedSession('session-a')
    const afterFirst = await readFile(storePath, 'utf-8')
    expect(JSON.parse(afterFirst)).toBeTruthy()

    await seedSession('session-b')
    // Both candidates parse: the previous generation was COPIED aside, not moved.
    expect(JSON.parse(await readFile(storePath, 'utf-8'))).toBeTruthy()
    expect(JSON.parse(await readFile(`${storePath}.bak`, 'utf-8'))).toBeTruthy()
  })

  it('leaves no orphaned temp file behind', async () => {
    await seedSession('session-a')
    await seedSession('session-b')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('aborts the save rather than advancing the primary past a stale backup', async () => {
    await seedSession('session-a')
    const committed = await readFile(storePath, 'utf-8')
    const loaded = await loadAgentSessionStore(storePath, 'local')
    // A directory in the backup's place makes the rotation fail the way a full or read-only
    // disk would. The save must not publish a primary the backup can no longer match.
    await rm(`${storePath}.bak`, { force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(`${storePath}.bak`)

    await expect(
      saveAgentSessionStore(storePath, loaded.state, {
        primaryStatus: 'validated'
      })
    ).rejects.toBeTruthy()
    expect(await readFile(storePath, 'utf-8')).toBe(committed)
    expect((await stat(`${storePath}.bak`)).isDirectory()).toBe(true)
  })
})

describe('recovery from the committed backup', () => {
  it('completes the next transaction instead of refusing forever', async () => {
    await seedSession('session-a')
    await seedSession('session-b')
    // The exact shape a real profile wedged in: backup only, no live file.
    await rm(storePath, { force: true })

    await expect(seedSession('session-c')).resolves.toBeGreaterThan(0)
    expect(JSON.parse(await readFile(storePath, 'utf-8'))).toBeTruthy()
  })

  it('never grants the fence the lost commit could already have handed out', async () => {
    const fence = await seedSession('session-a')
    // A second commit is what produces the backup; the first write has nothing to rotate.
    await seedSession('session-b')
    await rm(storePath, { force: true })

    const store = await openStore()
    // The floor lands in the first transaction after recovery, not at load.
    await store.retireClaimKey(`retire-${operationId()}`, NOW)
    const record = store.getRecord('session-a')
    expect(record).toBeTruthy()

    // The lost commit could have granted fence + 1. Adjudication must skip it, or two writers
    // end up holding the same number under strict-equality comparison.
    const granted = evaluateAgentSessionAcquisition({
      lease: { ...record!.lease, unreconciled: false, ownerProcess: null, claimStatus: 'released' },
      expectedFence: record!.lease.runtimeFence,
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' }
    })
    expect(granted.decision).toBe('granted')
    expect(granted.decision === 'granted' && granted.nextFence).toBeGreaterThan(fence + 1)
  })

  it('leaves recovered records valid, so the next load does not quarantine them', async () => {
    await seedLiveSession('session-a')
    await seedSession('session-b')
    await rm(storePath, { force: true })

    const store = await openStore()
    await store.retireClaimKey(`retire-${operationId()}`, NOW)
    const record = store.getRecord('session-a')
    expect(record?.lease.claimStatus).toBe('live')
    // A `live` lease means a provider handle proven at exactly lease.runtimeFence. Recovery that
    // rewrote the fence broke that, so the record failed validation, was quarantined on the next
    // load, and dropped straight back to the same backup.
    expect(isAgentSessionRecord(record)).toBe(true)
  })

  it('carries ownership evidence forward verbatim', async () => {
    await seedSession('session-a')
    await seedSession('session-b')
    const before = (await loadAgentSessionStore(`${storePath}.bak`, 'local')).state.records.get(
      'session-a'
    )!
    await rm(storePath, { force: true })

    const store = await openStore()
    await store.retireClaimKey(`retire-${operationId()}`, NOW)
    const after = store.getRecord('session-a')!
    expect(after.lease.claimStatus).toBe(before.lease.claimStatus)
    expect(after.lease.ownerProcess).toEqual(before.lease.ownerProcess)
    expect(after.lease.handoffStage).toBe(before.lease.handoffStage)
    // "Not currently owned" is expressed by unreconciled, not by erasing the evidence.
    expect(after.lease.unreconciled).toBe(true)
  })

  // Recovery restores the previous COMMITTED generation; the lost commit is lost by definition.
  // What must not happen is reconciliation dropping anything the backup did hold.
  it('drops nothing the committed backup held', async () => {
    await seedSession('session-a')
    await seedSession('session-b')
    const before = (await loadAgentSessionStore(`${storePath}.bak`, 'local')).state
    await rm(storePath, { force: true })

    const store = await openStore()
    await store.retireClaimKey(`retire-${operationId()}`, NOW)
    const after = (await loadAgentSessionStore(storePath, 'local')).state
    expect([...after.records.keys()].sort()).toEqual([...before.records.keys()].sort())
    expect(after.operations.size).toBe(before.operations.size)
    // Everything the backup held is still there; the transaction that drove recovery adds its own.
    for (const key of before.retiredClaimKeys) {
      expect(after.retiredClaimKeys).toContainEqual(key)
    }
    expect([...after.unreadableRecords.keys()]).toEqual([...before.unreadableRecords.keys()])
  })
})

describe('a transient primary read failure is not recovery', () => {
  it('refuses rather than falling back to a usable but older backup', async () => {
    await seedSession('session-a')
    // The second commit leaves a VALID backup, so a fallback would silently succeed with
    // older state — the failure this guard exists to prevent.
    await seedSession('session-b')
    expect(
      (await loadAgentSessionStore(`${storePath}.bak`, 'local')).state.records.has('session-a')
    ).toBe(true)

    // A directory at the primary path fails the read with EISDIR, not ENOENT — the shape of a
    // permission or IO fault. It says nothing about the primary's contents.
    await rm(storePath, { force: true })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(storePath)

    await expect(loadAgentSessionStore(storePath, 'local')).rejects.toThrow(
      'agent_session_store_corrupt'
    )
  })
})

describe('the fence-step bound the +2 floor rests on', () => {
  it('advances a session fence by exactly one per grant when no floor is set', () => {
    const granted = evaluateAgentSessionAcquisition({
      lease: agentSessionLeaseFixture({
        runtimeFence: 7,
        claimStatus: 'released',
        ownerProcess: null,
        provenHandleLinkId: null
      }),
      expectedFence: 7,
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' }
    })
    // If a grant could ever advance by more than one, the +2 recovery floor would stop dominating
    // the highest fence a single lost commit can have handed out.
    expect(granted.decision === 'granted' && granted.nextFence).toBe(8)
  })

  it('honours a recovery floor that sits above the next step', () => {
    const granted = evaluateAgentSessionAcquisition({
      lease: agentSessionLeaseFixture({
        runtimeFence: 7,
        minimumNextFence: 9,
        claimStatus: 'released',
        ownerProcess: null,
        provenHandleLinkId: null
      }),
      expectedFence: 7,
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' }
    })
    expect(granted.decision === 'granted' && granted.nextFence).toBe(9)
  })
})

describe('a store that never existed', () => {
  it('does not claim recovery', async () => {
    await writeFile(join(root, 'unrelated.txt'), 'x', 'utf-8')
    const loaded = await loadAgentSessionStore(storePath, 'local')
    expect(loaded.storeFound).toBe(false)
    expect(loaded.recoveredFromBackup).toBe(false)
  })
})
