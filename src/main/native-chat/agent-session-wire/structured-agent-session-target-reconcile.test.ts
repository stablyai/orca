import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { AgentSessionReserveRequest } from '../../runtime/agent-session-reservation-admission'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../agent-session-journal/journal-host-database-test-support'
import { createRestartReconciler } from './structured-agent-session-restart-reconcile'

const NOW = 1_800_000_000_000
const UNUSED: AgentSessionOwnerProbe = { outcome: 'reservation-unused' }
let root: string
let store: AgentSessionRecordStore
let operation = 0

function reservation(sessionId: string): AgentSessionReserveRequest {
  operation += 1
  return {
    sessionId,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-workspace',
      workspaceKind: 'folder' as const
    },
    provider: 'codex' as const,
    accountHome: { variable: 'CODEX_HOME' as const, path: root },
    expectedFence: null,
    spawnToken: sessionId,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: UNUSED,
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-${operation.toString(16).padStart(32, '0')}`,
      fingerprint: sessionId
    },
    now: NOW
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-targeted-reconcile-'))
  operation = 0
  const previous = await openTestAgentSessionRecordStore(root)
  await previous.reserveOwner(reservation('session-1'))
  await previous.reserveOwner(reservation('session-2'))
  for (const sessionId of ['session-1', 'session-2']) {
    await previous.commitProcessIdentity({
      sessionId,
      fence: previous.getRecord(sessionId)?.lease.runtimeFence ?? 0,
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: NOW,
        spawnToken: sessionId
      },
      now: NOW
    })
  }
  store = await openTestAgentSessionRecordStore(root)
})

afterEach(async () => {
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('targeted restart reconciliation', () => {
  it("does not fail an action because another chat's owner check fails", async () => {
    const probe = vi.fn(async (record: AgentSessionRecord) => {
      if (record.sessionId === 'session-2') {
        throw new Error('owner check failed')
      }
      return UNUSED
    })
    const reconcile = createRestartReconciler({ store, probe, now: () => NOW })

    expect(await reconcile('session-1')).toBeNull()
    expect(probe).toHaveBeenCalledOnce()
    expect(store.getRecord('session-2')?.lease.unreconciled).toBe(true)
    await expect(reconcile('session-2')).rejects.toThrow('owner check failed')
  })

  it("settles a chat while another chat's record changes under every check of it", async () => {
    let renames = 0
    const probe = vi.fn(async (record: AgentSessionRecord) => {
      if (record.sessionId === 'session-2') {
        renames += 1
        // Each check of session-2 is stale by the time it applies.
        await store.setConversationName('session-2', `renamed ${renames}`)
      }
      return UNUSED
    })
    const reconcile = createRestartReconciler({ store, probe, now: () => NOW })

    expect(await reconcile('session-1')).toBeNull()
    expect(store.getRecord('session-1')?.lease.unreconciled).toBe(false)
    // The whole-host pass does run out of passes on session-2.
    expect(await reconcile()).not.toBeNull()
    expect(store.getRecord('session-2')?.lease.unreconciled).toBe(true)
  })

  it("does not wait on another chat's stalled owner check in the startup batch", async () => {
    let release: (probe: AgentSessionOwnerProbe) => void = () => undefined
    let started: () => void = () => undefined
    const probing = new Promise<void>((resolve) => {
      started = resolve
    })
    const waiting = new Promise<AgentSessionOwnerProbe>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(async (record: AgentSessionRecord) => {
      if (record.sessionId === 'session-2') {
        started()
        return waiting
      }
      return UNUSED
    })
    const reconcile = createRestartReconciler({ store, probe, now: () => NOW })
    const startup = reconcile()
    await probing
    const target = reconcile('session-1')
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      expect(
        await Promise.race([
          target,
          new Promise<string>((resolve) => {
            timeout = setTimeout(() => resolve('blocked'), 1_000)
          })
        ])
      ).toBeNull()
      expect(store.getRecord('session-2')?.lease.unreconciled).toBe(true)
    } finally {
      clearTimeout(timeout)
      release(UNUSED)
      await Promise.all([startup, target])
    }
  })

  it('joins simultaneous checks of the same session', async () => {
    const probe = vi.fn(async () => UNUSED)
    const reconcile = createRestartReconciler({ store, probe, now: () => NOW })
    expect(await Promise.all([reconcile('session-1'), reconcile('session-1')])).toEqual([
      null,
      null
    ])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does no reconciliation for a new chat or a session already reconciled', async () => {
    const probe = vi.fn(async () => UNUSED)
    const reconcile = createRestartReconciler({ store, probe, now: () => NOW })
    expect(await reconcile('new-session')).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    expect(await reconcile('session-1')).toBeNull()
    expect(await reconcile('session-1')).toBeNull()
    expect(probe).toHaveBeenCalledOnce()
  })

  it('keeps an unproven target in recovery and refuses a new writer', async () => {
    const reconcile = createRestartReconciler({
      store,
      probe: async () => ({ outcome: 'indeterminate', reason: 'owner runs on another host' }),
      now: () => NOW
    })
    expect(await reconcile('session-1')).toBeNull()
    const fence = store.getRecord('session-1')?.lease.runtimeFence ?? 0
    await expect(
      store.reserveOwner({
        ...reservation('session-1'),
        expectedFence: fence,
        probe: { outcome: 'indeterminate', reason: 'owner runs on another host' }
      })
    ).rejects.toThrow('agent_session_ownership_unknown')
  })

  it('still batches every pending record for explicit startup reconciliation', async () => {
    const probeMany = vi.fn(
      async (records: readonly AgentSessionRecord[]) =>
        new Map(records.map((record) => [record.sessionId, UNUSED]))
    )
    const reconcile = createRestartReconciler({
      store,
      probe: async () => UNUSED,
      probeMany,
      now: () => NOW
    })
    expect(await reconcile()).toBeNull()
    expect(probeMany.mock.calls[0]?.[0].map((record) => record.sessionId)).toEqual([
      'session-1',
      'session-2'
    ])
  })
})
