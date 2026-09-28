/**
 * Decoding a lease the removed terminal handoff wrote. Separate from the store's main suite only
 * because that file is at its line cap.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import {
  readPersistedLease,
  writeOlderBuildLease
} from './agent-session-older-build-lease.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const MATCHED: AgentSessionOwnerProbe = { outcome: 'identity-matched', matchedOn: ['spawn-token'] }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-legacy-lease-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const open = (): Promise<AgentSessionRecordStore> =>
  AgentSessionRecordStore.open({ directory, hostId: 'local' })

async function persistLiveOwner(): Promise<void> {
  const store = await open()
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    // Without one the next open backfills it, and that rewrite would mask the lease's own.
    surfaceTabId: 'tab-alpha',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no answer' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'0'.repeat(32)}`,
      fingerprint: 'fp'
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: { hostId: 'local', pid: 4242, processStartTimeMs: NOW - 1_000, spawnToken: 'spawn-a' },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'link-1',
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW,
      handle: { provider: 'claude', sessionId: 'provider-session-alpha', leafUuid: null }
    },
    now: NOW
  })
  // Commits the visibility index, so a later hide changes nothing but a pending rewrite.
  await store.setSessionTabVisibility(SESSION, false)
}

describe('a lease the removed terminal handoff wrote', () => {
  it('loads normalized instead of quarantined, and reaches disk with the first transaction', async () => {
    await persistLiveOwner()
    await writeOlderBuildLease(directory, SESSION, {
      runtimeKind: 'tui',
      handoffStage: 'old-owner-stopped',
      handoffOperationId: 'op-handoff'
    })
    const legacy = await readFile(agentSessionStorePath(directory), 'utf-8')

    const store = await open()
    expect(store.isSessionUnreadable(SESSION)).toBe(false)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering',
      handoffOperationId: 'op-handoff',
      claimStatus: 'conflicted'
    })
    // An open does not write: another holder of the file mid-restart would read it as a change.
    expect(await readFile(agentSessionStorePath(directory), 'utf-8')).toBe(legacy)

    // A transaction that changes nothing still writes it. Had the open's revision been taken over
    // anything but the normalized state, this would read the file as externally changed and
    // reload it, dropping the pending write.
    await store.setSessionTabVisibility(SESSION, false)
    expect(await readPersistedLease(directory, SESSION)).toMatchObject({
      runtimeKind: 'native',
      handoffStage: 'recovering',
      claimStatus: 'conflicted'
    })
  })

  it('keeps the adjudicated lease after a save, so the saved file hashes to memory', async () => {
    await persistLiveOwner()
    await writeOlderBuildLease(directory, SESSION, { runtimeKind: 'tui' })
    const store = await open()
    await store.reconcileOnRestart({ probe: async () => MATCHED, now: NOW + 1_000 })
    expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(false)

    // A reload after a mismatched hash would mark every lease unadjudicated again.
    await store.setSessionTabVisibility(SESSION, true)
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      unreconciled: false,
      claimStatus: 'conflicted',
      handoffStage: 'recovering'
    })
    const settled = await readFile(agentSessionStorePath(directory), 'utf-8')
    await open()
    expect(await readFile(agentSessionStorePath(directory), 'utf-8')).toBe(settled)
  })
})
