// @orca-isolated-worker -- Owns the storage and clock for a real journal writer and host.
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { encodeAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { claudeProviderHandle } from '../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  closeTestAgentSessionDatabase,
  openTestAgentSessionDatabase,
  openTestAgentSessionRecordStore
} from '../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import Database from '../../../../sqlite/sync-database'
import { createJournalTablesSql } from '../../../agent-session-journal/database/journal-database-schema'
import { journalDatabasePath } from '../../../agent-session-journal/database/journal-host-database'
import { journalLegacyRecordPaths } from '../../../agent-session-journal/database/journal-legacy-record-paths'
import { agentSessionRecordFixture } from '../../../testing/agent-session-record-test-fixture'
import { claudeAndCodexDeclared } from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { StructuredAgentSessionHost } from '../structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../structured-agent-session-logger'
import { createQueuedRigProvider } from './structured-agent-session-queued-message-rig-provider.test-fixture'

const historicalId = (index: number) => `historical-chat-${index}`

function seedProfile(root: string, count: number): void {
  const db = new Database(journalDatabasePath(root))
  try {
    db.exec(createJournalTablesSql())
    db.pragma('user_version=3')
  } finally {
    db.close()
  }
  const [primary] = journalLegacyRecordPaths(root)
  mkdirSync(dirname(primary))
  const fd = openSync(primary, 'wx')
  try {
    writeSync(fd, '{"schemaVersion":2,"hostId":"local","records":{')
    let pending = ''
    for (let index = 0; index < count; index += 1) {
      const id = historicalId(index)
      const record = encodeAgentSessionRecord(agentSessionRecordFixture({ sessionId: id }))
      pending += `${index === 0 ? '' : ','}${JSON.stringify(id)}:${JSON.stringify(record)}`
      if (pending.length > 64 * 1024) {
        writeSync(fd, pending)
        pending = ''
      }
    }
    writeSync(fd, pending)
    writeSync(fd, '},"operations":{},"retiredClaimKeys":[],"unusableRecords":{},"sessionTabs":[]}')
  } finally {
    closeSync(fd)
  }
}

async function openHost(root: string) {
  const store = await openTestAgentSessionRecordStore(root)
  const journalDatabase = await openTestAgentSessionDatabase(root)
  const probe = vi.fn(async () => ({
    outcome: 'identity-matched' as const,
    matchedOn: ['spawn-token' as const]
  }))
  const provider = createQueuedRigProvider(store, {}, () => host)
  const host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: provider.adapter,
    journalDatabase,
    probeOwner: probe,
    claimKeyId: 'timer-fixture',
    mintSpawnToken: () => 'timer-fixture-token',
    idleSweep: { idleMs: () => 0 }
  })
  await host.reconcileRestartLeases()
  return { host, store, probe, journalDatabase }
}

it('keeps history-only upgrades and restarts free of host timer callbacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-chat-timer-upgrade-'))
  const count = Number(process.env.ORCA_TEST_HISTORICAL_TIMER_RECORDS ?? '100')
  let host: StructuredAgentSessionHost | undefined
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    seedProfile(root, count)
    for (let launch = 0; launch < 2; launch += 1) {
      const opened = await openHost(root)
      host = opened.host
      const read = vi.spyOn(opened.journalDatabase.readers, 'point')
      expect(opened.store.conversationCount()).toBe(count)
      expect(opened.store.getVisibleSessionTabIndex()).toEqual({ present: true, sessionIds: [] })
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(600_000)
      expect(vi.getTimerCount()).toBe(0)
      expect(read).not.toHaveBeenCalled()
      await host.flushAllStreamedEvents()
      host = undefined
      await closeTestAgentSessionDatabase(root)
    }
  } finally {
    try {
      await host?.flushAllStreamedEvents()
      await closeTestAgentSessionDatabase(root).catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  }
}, 180_000)

it('keeps the existing deadlines only while chats or leases need them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-chat-timer-owners-'))
  let host: StructuredAgentSessionHost | undefined
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    seedProfile(root, 3)
    const opened = await openHost(root)
    host = opened.host
    const { store, probe } = opened
    const { lifetime, sessions } = host.collaboratorsForTests()
    const continueTick = vi.spyOn(host.usageLimitContinue, 'tick')
    const idleTick = vi.spyOn(lifetime.idleSweep, 'tick')
    const id = historicalId(0)
    await store.setSessionTabVisibility(id, true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(continueTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(continueTick).toHaveBeenCalledTimes(1)
    await store.setSessionTabVisibility(id, false)
    expect(vi.getTimerCount()).toBe(0)

    await lifetime.conversation(id)
    expect(sessions.has(id)).toBe(true)
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(idleTick).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(idleTick).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(sessions.has(id)).toBe(false))
    expect(vi.getTimerCount()).toBe(0)

    const makeLease = async (index: number) => {
      const sessionId = historicalId(index)
      const record = store.getRecord(sessionId)!
      const now = Date.now()
      const reserved = await store.reserveOwner({
        sessionId,
        location: record.location,
        provider: record.provider,
        accountHome: record.accountHome,
        expectedFence: record.lease.runtimeFence,
        spawnToken: `fixture-${index}`,
        claimKeyId: 'timer-fixture',
        handoffOperationId: null,
        probe: { outcome: 'pid-absent' },
        operation: {
          callerKey: 'fixture',
          operationId: `${now}-${String(index).padStart(32, '0')}`,
          fingerprint: `fixture-${index}`
        },
        now
      })
      expect(vi.getTimerCount()).toBe(index === 1 ? 0 : 1)
      const fence = reserved.record.lease.runtimeFence
      await store.commitProcessIdentity({
        sessionId, fence, now,
        process: {
          hostId: 'local',
          pid: 1000 + index,
          processStartTimeMs: now,
          spawnToken: `fixture-${index}`
        }
      })
      await store.proveOwner({
        sessionId, fence, now,
        link: {
          linkId: `fixture-link-${index}`,
          handle: claudeProviderHandle(`fixture-provider-${index}`, 'fixture-leaf'),
          origin: 'created',
          mintedAtFence: fence,
          observedAt: now
        }
      })
      return { sessionId, fence }
    }
    const release = (owner: Awaited<ReturnType<typeof makeLease>>) =>
      store.evictProvenDeadOwner({
        sessionId: owner.sessionId,
        expectedFence: owner.fence,
        probe: { outcome: 'pid-absent' },
        now: Date.now()
      })
    const first = await makeLease(1)
    const second = await makeLease(2)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(probe).not.toHaveBeenCalled()
    await release(first)
    const renewalDeadline = Date.now() + 1
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() =>
      expect(store.getRecord(second.sessionId)?.lease.lastRenewedAt).toBe(renewalDeadline)
    )
    expect(probe.mock.calls).toHaveLength(1)
    await release(second)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    try {
      await host?.flushAllStreamedEvents()
      await closeTestAgentSessionDatabase(root).catch(() => {})
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
      rmSync(root, { recursive: true, force: true })
    }
  }
})
