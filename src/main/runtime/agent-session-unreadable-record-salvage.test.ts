// Unreadable session records: quarantine when nothing can vouch for the session, salvage
// when the previous committed state can.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
let directory: string
let counter = 0

function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no answer' },
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

async function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

/** Reserve, observe the spawn, prove the handle — the full path to an admitted writer. */
async function establishOwner(store: AgentSessionRecordStore): Promise<AgentSessionRecord> {
  const reserved = await store.reserveOwner(reserveRequest())
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: 'session-alpha',
    fence,
    process: {
      hostId: 'local',
      pid: 4242,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a'
    },
    now: NOW
  })
  return store.proveOwner({
    sessionId: 'session-alpha',
    fence,
    link: {
      linkId: 'link-1',
      handle: { provider: 'claude', sessionId: 'provider-session-1', leafUuid: 'leaf-1' },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
}

async function corruptPrimaryRecord(): Promise<string> {
  const filePath = agentSessionStorePath(directory)
  const raw = JSON.parse(await readFile(filePath, 'utf-8'))
  raw.records['session-alpha'].lease.runtimeFence = 'not-a-number'
  await writeFile(filePath, JSON.stringify(raw))
  return filePath
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-salvage-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('unreadable session records', () => {
  it('quarantines an unreadable record with no committed copy and refuses to own it', async () => {
    const first = await open()
    await establishOwner(first)
    const filePath = await corruptPrimaryRecord()
    // No previous committed state survives, so nothing can vouch for the session.
    await rm(`${filePath}.bak`, { force: true })

    const reopened = await open()
    expect(reopened.getRecord('session-alpha')).toBeNull()
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(true)
    await expect(reopened.reserveOwner(reserveRequest())).rejects.toThrow(
      'execution_owner_reconciling'
    )
    // The row stays verbatim inside an explicit unusable envelope.
    await reopened.retireClaimKey('key-2', NOW)
    const persisted = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(persisted.records).not.toHaveProperty('session-alpha')
    expect(persisted.unusableRecords['session-alpha']).toMatchObject({
      reason: 'current_shape_invalid',
      raw: { lease: { runtimeFence: 'not-a-number' } }
    })
  })

  it('salvages the last committed copy of a record the primary retains as unreadable', async () => {
    const first = await open()
    await establishOwner(first)
    // One more commit leaves the proven-owner record in the backup file.
    await first.setJournalCheckpoint({
      sessionId: 'session-alpha',
      fence: 1,
      checkpoint: { epoch: 1, sequence: 1 },
      now: NOW
    })
    const filePath = await corruptPrimaryRecord()

    const reopened = await open()
    // The previous committed state vouches for the session; its lease is re-adjudicated
    // like any other, and the unreadable bytes stay quarantined verbatim.
    expect(reopened.getRecord('session-alpha')?.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'live'
    })
    expect(reopened.recoveredFromBackup).toBe(false)
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(true)
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: NOW + 1
    })
    expect(reopened.getRecord('session-alpha')?.lease.claimStatus).toBe('released')

    // Ownership is reachable again instead of refused with execution_owner_reconciling.
    const reserved = await reopened.reserveOwner(
      reserveRequest({ expectedFence: 2, spawnToken: 'spawn-b' })
    )
    expect(reserved.record.lease.claimStatus).toBe('reserved')
    const persisted = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(persisted.records['session-alpha'].lease.claimStatus).toBe('reserved')
    expect(persisted.unusableRecords['session-alpha']).toMatchObject({
      reason: 'current_shape_invalid'
    })

    // Salvage only fills gaps: with the live record readable again, a reload must never
    // let the stale backup copy clobber it.
    const reloaded = await open()
    expect(reloaded.getRecord('session-alpha')?.lease).toMatchObject({
      claimStatus: 'reserved',
      runtimeFence: 3
    })
  })
})
