// Host startup from each chat's stored state: settled chats get their status rows without being
// opened, every chat that owes work is settled with no user action (tab or no tab), and a chat is
// opened only when stored state cannot answer for it.

import { cp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  readTestJournalSessionStatus
} from '../agent-session-journal/journal-host-database-test-support'
import Database from '../../sqlite/sync-database'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session-record.test-fixture'
import {
  createStructuredAgentSessionStartupState,
  type StructuredAgentSessionStartupStateDeps
} from './structured-agent-session-startup-state'
import { readUnsettledJournalSessionIds } from '../agent-session-journal/journal-session-state'
import { StructuredAgentSessionStartupGate } from '../../runtime/structured-agent-session-startup-gate'
import { writeOlderBuildLease } from '../../runtime/agent-session-older-build-lease.test-fixture'
import { editPersistedTestAgentSessionStore } from '../../runtime/agent-session-record-store-test-harness'
import { hostTestOperationId } from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestChat,
  sendRestTestMessage,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import {
  latestRestTestStatus,
  restTestOpens
} from './structured-agent-session-rest-test-observations'
import { moveRestTestChatToPerChatFile } from './structured-agent-session-rest-test-per-chat-file'

const rigs: RestTestRig[] = []

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    await rig.dispose()
  }
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

async function newRig(root?: string): Promise<RestTestRig> {
  const rig = await createRestTestRig({}, root ? { root } : {})
  rigs.push(rig)
  return rig
}

function db(rig: RestTestRig) {
  return openTestJournalHostDatabase(rig.root).db
}

/** A send the provider only admitted, so it stays unanswered: the crash leaves it owed. */
async function crashMidSend(rig: RestTestRig, sessionId: string, listed = true): Promise<void> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
}

/** A chat whose turn is running when Orca dies: startup selects it to settle. */
async function crashMidTurn(rig: RestTestRig, sessionId: string): Promise<void> {
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
  const [{ providerIdentity }] = await Promise.all(
    rig.adapter.dispatch.mock.results.slice(-1).map((result) => result.value)
  )
  await rig.host
    .collaboratorsForTests()
    .sessions.get(sessionId)!
    .journal.appendItem(
      { ...providerIdentity, ordinal: 0 },
      { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
      { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
    )
}

/** What startup runs, in order, on the ids the tab list names. */
async function startup(rig: RestTestRig, listed: readonly string[]) {
  await rig.host.reconcileRestartLeases()
  await rig.host.catchUpMissingStatuses(listed)
  await rig.host.restoreListedFromPerChatFiles(listed)
  const background = rig.host.seedStoredStatuses(listed)
  await rig.host.settleOwedSessions(listed)
  await rig.host.restoreReadableSessions(background)
  return background
}

function opened(rig: RestTestRig, ids: readonly string[]): string[] {
  return ids.filter((sessionId) => restTestOpens(rig, sessionId) > 0)
}

function statusRows(rig: RestTestRig, sessionId: string): AgentSessionStatusSummary[] {
  return rig.statusEvents.flatMap((event) =>
    event.type === 'status' && event.session.sessionId === sessionId ? [event.session] : []
  )
}

const listedIds = (rig: RestTestRig) => rig.store.getVisibleSessionTabIndex().sessionIds

describe('seeding statuses from stored state', () => {
  it('seeds each settled chat exactly as its open would publish it (T5)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-answered', { message: 'finished work' })
    await restTestChat(rig, 'session-quiet')
    rig.adapter.dispatch.mockResolvedValueOnce({
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
        surface: 'rejection'
      })
    })
    await restTestChat(rig, 'session-refused', { message: 'refused' })
    await rig.host.flushAllStreamedEvents()
    const ids = ['session-answered', 'session-quiet', 'session-refused']
    closeTestJournalHostDatabases()
    const readRoot = `${rig.root}-read`
    await cp(rig.root, readRoot, { recursive: true })
    const readRig = await newRig(readRoot)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    expect(host.seedStoredStatuses(ids)).toEqual([])
    expect(opened(rig, ids)).toEqual([])
    // The same chats in another run, each opened by a read.
    await readRig.host.reconcileRestartLeases()
    for (const sessionId of ids) {
      await readRig.host.history({ sessionId, direction: 'tail' })
    }

    for (const sessionId of ids) {
      // Every field, `updatedAt` included: both come from the journal's own newest activity.
      expect(latestRestTestStatus(rig, sessionId)).toEqual(latestRestTestStatus(readRig, sessionId))
    }
    expect(latestRestTestStatus(rig, 'session-refused')).toMatchObject({ turnOutcome: 'failure' })
    // Opening a seeded chat finds its row equal and sends nothing.
    const seeded = ids.map((sessionId) => statusRows(rig, sessionId).length)
    for (const sessionId of ids) {
      await host.history({ sessionId, direction: 'tail' })
    }
    expect(ids.map((sessionId) => statusRows(rig, sessionId).length)).toEqual(seeded)
  })

  it('seeds a crash-cut turn with the verdict its open publishes (T5, interrupted and unconfirmed)', async () => {
    const rig = await newRig()
    const ids = ['session-interrupted', 'session-unconfirmed']
    for (const sessionId of ids) {
      await restTestChat(rig, sessionId, { message: `asked ${sessionId}` })
      const [{ providerIdentity }] = await Promise.all(
        rig.adapter.dispatch.mock.results.slice(-1).map((result) => result.value)
      )
      const session = rig.host.collaboratorsForTests().sessions.get(sessionId)!
      // The turn's own row, beside the accepted message the dispatch's identity names.
      await session.journal.appendItem(
        { ...providerIdentity, ordinal: 0 },
        { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
        {
          fence: rig.store.getRecord(sessionId)!.lease.runtimeFence,
          turnScope: { kind: 'thread' }
        }
      )
    }
    await rig.crash()
    // The unconfirmed chat's owner can never be judged; the other's is proven gone.
    const probe = async (record: { sessionId: string }) =>
      record.sessionId === 'session-unconfirmed'
        ? { outcome: 'indeterminate' as const, reason: 'no start time' }
        : { outcome: 'pid-absent' as const }
    rig.probeOwner.mockImplementation(probe)
    await rig.boot()
    await startup(rig, ids)
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    closeTestJournalHostDatabases()
    const readRoot = `${rig.root}-read`
    await cp(rig.root, readRoot, { recursive: true })
    const readRig = await newRig(readRoot)
    readRig.probeOwner.mockImplementation(probe)

    const host = await rig.boot()
    await host.reconcileRestartLeases()
    expect(host.seedStoredStatuses(ids)).toEqual([])
    expect(opened(rig, ids)).toEqual([])
    await readRig.host.reconcileRestartLeases()
    for (const sessionId of ids) {
      await readRig.host.history({ sessionId, direction: 'tail' })
    }

    for (const sessionId of ids) {
      expect(latestRestTestStatus(rig, sessionId)).toEqual(latestRestTestStatus(readRig, sessionId))
    }
    expect(latestRestTestStatus(rig, 'session-interrupted')).toMatchObject({
      turnOutcome: 'interruption'
    })
    expect(latestRestTestStatus(rig, 'session-unconfirmed')).toMatchObject({
      turnOutcome: 'unconfirmed'
    })
  })

  it('has every settled chat in the first snapshot a later subscriber gets (T8, T17)', async () => {
    const rig = await newRig()
    for (const sessionId of ['session-1', 'session-2']) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()
    const host = await rig.boot()
    host.seedStoredStatuses(listedIds(rig))
    const snapshots: AgentSessionStatusSummary[][] = []
    host.subscribeStatus({
      id: 'remote-client',
      emit: (event) => {
        if (event.type === 'snapshot') {
          snapshots.push(event.sessions)
        }
      }
    })
    expect(snapshots[0]?.map((row) => [row.sessionId, row.status])).toEqual([
      ['session-1', 'idle'],
      ['session-2', 'idle']
    ])
  })

  it('reaches the status observers once per seeded chat, as a replay (T13)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-1', { message: 'hi' })
    await rig.crash()
    const onSessionStatusChanged = vi.fn()
    const host = await rig.boot({ onSessionStatusChanged })
    host.seedStoredStatuses(['session-1'])
    expect(onSessionStatusChanged).toHaveBeenCalledOnce()
    expect(onSessionStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1', status: 'idle' }),
      { replay: true }
    )
  })

  it('drops a seeded chat from the status store when its tab closes (T12)', async () => {
    const rig = await newRig()
    await restTestChat(rig, 'session-1', { message: 'hi' })
    await rig.crash()
    const host = await rig.boot()
    host.seedStoredStatuses(['session-1'])
    expect(rig.sink.publish).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      expect.anything()
    )

    await host.setSessionTabVisibility('session-1', false)

    expect(host.hasSession('session-1')).toBe(false)
    expect(rig.sink.forget).toHaveBeenCalledOnce()
  })

  it('seeds nothing and settles nothing from a newer build database (T16, regression guard)', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-crashed')
    await restTestChat(rig, 'session-settled', { message: 'done' })
    await rig.crash()
    closeTestJournalHostDatabases()
    const raw = new Database(join(rig.root, 'agent-session-journal.db'))
    raw.pragma('user_version = 99')
    raw.close()
    const host = await rig.boot()
    const ids = listedIds(rig)

    expect(host.seedStoredStatuses(ids)).toEqual(ids)
    await host.settleOwedSessions(ids)
    expect(rig.sink.publish).not.toHaveBeenCalled()
    expect(opened(rig, ids)).toEqual([])
  })
})

describe('startup opens only what it must (T6, T7, T14)', () => {
  it('settles crashed chats with or without a tab, and opens only what stored state cannot answer', async () => {
    const rig = await newRig()
    const settled = Array.from({ length: 8 }, (_, index) => `session-settled-${index}`)
    for (const sessionId of settled) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await crashMidSend(rig, 'session-crashed')
    await crashMidSend(rig, 'session-crashed-closed', false)
    for (const sessionId of ['session-rowless', 'session-draft', 'session-uncopied']) {
      await restTestChat(rig, sessionId, { message: sessionId })
    }
    await rig.crash()

    // Last written before its status table existed: it has a journal and no status.
    db(rig).prepare('DELETE FROM journal_session_state WHERE session_id = ?').run('session-rowless')
    // A draft an earlier process queued: paused by the restart, so an open would send nothing.
    db(rig)
      .prepare(
        `INSERT INTO queued_messages (session_id, message_id, position, body_json, fingerprint,
        created_at, host_instance, state) VALUES (?, 'draft-1', 1, ?, 'fp', 1, 'host-a', 'waiting')`
      )
      .run(
        'session-draft',
        JSON.stringify({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'x' }] })
      )
    // Still in the format a pre-database build wrote: nothing of it is in the host's database.
    for (const table of ['journal_rows', 'journal_sessions', 'journal_session_state']) {
      db(rig).prepare(`DELETE FROM ${table} WHERE session_id = ?`).run('session-uncopied')
    }
    const legacy = openTestJournalHostDatabase(rig.root).legacyDirectoryFor({
      workspaceId: 'workspace-1',
      sessionId: 'session-uncopied'
    })
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'log.jsonl'), '{}\n')

    await rig.boot()
    const listed = listedIds(rig)
    expect(listed).not.toContain('session-crashed-closed')
    const background = await startup(rig, listed)

    const unlisted = ['session-crashed-closed']
    // The rowless chat's row comes from its rows alone: it is never opened.
    expect(opened(rig, [...listed, ...unlisted]).toSorted()).toEqual(
      ['session-crashed', ...unlisted, 'session-uncopied'].toSorted()
    )
    // Its row is derived before the seed, and the per-chat file is opened before it: nothing is
    // left to the restore after the listing.
    expect(background).toEqual([])
    expect(latestRestTestStatus(rig, 'session-draft')).toMatchObject({ status: 'idle' })
    // Settled with no user action; the listed one is open and never showed its pre-crash work.
    for (const sessionId of ['session-crashed', ...unlisted]) {
      // The unanswered send is now recovered doubt, which projects as no running request.
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({
        lifecycle: 'idle',
        handedOverSends: 0,
        summary: { status: null }
      })
    }
    expect(rig.host.hasSession('session-crashed')).toBe(true)
    expect(statusRows(rig, 'session-crashed').map((row) => row.status)).not.toContain('working')
    // The tabless ones are settled and closed: never indexed, never given a status row (T14).
    for (const sessionId of unlisted) {
      expect(rig.host.hasSession(sessionId)).toBe(false)
      expect(rig.sink.publish.mock.calls.filter(([row]) => row.sessionId === sessionId)).toEqual([])
    }
    // Every settled chat has its row without being opened.
    for (const sessionId of settled) {
      expect(latestRestTestStatus(rig, sessionId)).toMatchObject({ status: 'idle' })
    }

    // The missing status was written back before the seed, and its row published, with no open.
    expect(readTestJournalSessionStatus(rig.root, 'session-rowless')).toMatchObject({
      lifecycle: 'idle'
    })
    expect(latestRestTestStatus(rig, 'session-rowless')).toMatchObject({ status: 'idle' })

    // The next boot finds nothing to settle and nothing without a status (T4b).
    await rig.crash()
    await rig.boot()
    const again = await startup(rig, listedIds(rig))
    expect(again).toEqual([])
    expect(opened(rig, [...listedIds(rig), ...unlisted])).toEqual([])
  })
})

describe('a provider process that outlived the crash (R1T-2)', () => {
  it('is stopped at startup for a listed and an unlisted chat, and none is left on the next boot', async () => {
    const rig = await newRig()
    // Attached, then sent to: its provider process is live when Orca dies.
    for (const [id, listed] of [
      ['session-idle-listed', true],
      ['session-idle-closed', false]
    ] as const) {
      await restTestChat(rig, id, { listed })
      await restTestChat(rig, id, { message: 'done', listed })
    }
    const ids = ['session-idle-listed', 'session-idle-closed']
    // Each chat's provider process was still up when Orca died: its lease names it, live.
    const leases = ids.map((id) => rig.store.getRecord(id)!.lease)
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    for (const lease of leases) {
      await writeOlderBuildLease(rig.root, lease.sessionId, { ...lease })
    }
    // The rig's chats share one recorded process; stopping it ends both.
    let alive = true
    const stopOwnerProcess = vi.fn(() => {
      alive = false
    })
    rig.probeOwner.mockImplementation(async () =>
      alive
        ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
        : { outcome: 'pid-absent' }
    )

    await rig.boot({ stopOwnerProcess })
    await startup(rig, listedIds(rig))

    expect(stopOwnerProcess).toHaveBeenCalled()
    expect(alive).toBe(false)
    for (const id of ids) {
      expect(rig.store.getRecord(id)!.lease).toMatchObject({
        handoffStage: null,
        ownerProcess: null,
        deathEvidence: { kind: 'pid-absent' }
      })
    }
    // The listed chat was seeded, not opened, and still had its process stopped.
    expect(opened(rig, ids)).toEqual([])

    await rig.crash()
    stopOwnerProcess.mockClear()
    await rig.boot({ stopOwnerProcess })
    await startup(rig, listedIds(rig))
    expect(stopOwnerProcess).not.toHaveBeenCalled()
  })

  it('is stopped for an unlisted chat whose lease a command checks after the lease check failed', async () => {
    const rig = await newRig()
    const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-listed', 'session-closed'])
    const listed = listedIds(rig)
    const failed = new Error('disk I/O error')
    vi.spyOn(rig.store, 'reconcileOnRestart')
      .mockRejectedValueOnce(failed)
      .mockRejectedValueOnce(failed)

    await rig.host.reconcileRestartLeases()
    expect(rig.store.getRecord('session-closed')!.lease.unreconciled).toBe(true)
    // An attach let through mid-catch-up checks the leases first, moving them to `recovering`;
    // what it answers after that does not matter here.
    const catchingUp = rig.host.catchUpMissingStatuses(listed)
    await restTestChat(rig, 'session-listed').catch(() => undefined)
    expect(rig.store.getRecord('session-closed')!.lease.handoffStage).toBe('recovering')
    await catchingUp
    await rig.host.restoreListedFromPerChatFiles(listed)
    rig.host.seedStoredStatuses(listed)
    // Owed: the crash cut its turn, so the settle opens it.
    expect(readUnsettledJournalSessionIds(db(rig))).toContain('session-closed')
    await rig.host.settleOwedSessions(listed)

    expectInterruptedAndStopped(rig, 'session-closed', stopOwnerProcess)
  })

  it("is stopped for an unlisted chat when the lease check's first try fails", async () => {
    const rig = await newRig()
    const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-open', 'session-closed'])
    const listed = listedIds(rig)
    expect(listed).toEqual(['session-open'])
    const reconcile = vi
      .spyOn(rig.store, 'reconcileOnRestart')
      .mockRejectedValueOnce(new Error('disk I/O error'))

    await startup(rig, listed)

    // The lease check's second try settles every lease; no restore checks them again.
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(stopOwnerProcess).toHaveBeenCalledTimes(1)
    expectInterruptedAndStopped(rig, 'session-closed', stopOwnerProcess)
  })

  it('is stopped for an unlisted chat whose lease a command checks once the settle is running', async () => {
    const rig = await newRig()
    const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-listed', 'session-closed'])
    const listed = listedIds(rig)
    const failed = new Error('disk I/O error')
    const reconcile = vi
      .spyOn(rig.store, 'reconcileOnRestart')
      .mockRejectedValueOnce(failed)
      .mockRejectedValueOnce(failed)
    await rig.host.reconcileRestartLeases()
    await rig.host.catchUpMissingStatuses(listed)
    await rig.host.restoreListedFromPerChatFiles(listed)
    rig.host.seedStoredStatuses(listed)

    const settling = rig.host.settleOwedSessions(listed)
    // The settle has waited on its recoveries and read its records; an attach the gate let through
    // now checks the leases, and what it answers after that does not matter here.
    await new Promise((resolve) => setImmediate(resolve))
    expect(rig.store.getRecord('session-closed')!.lease.unreconciled).toBe(true)
    await restTestChat(rig, 'session-listed').catch(() => undefined)
    await settling

    expect(reconcile).toHaveBeenCalledTimes(3)
    expect(stopOwnerProcess).toHaveBeenCalledTimes(1)
    expectInterruptedAndStopped(rig, 'session-closed', stopOwnerProcess)
  })

  it('is stopped for a listed chat still in its per-chat file whose lease a command checks after the lease check failed', async () => {
    const rig = await newRig()
    const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-file', 'session-other'], {
      live: 'session-file',
      beforeBoot: () => moveRestTestChatToPerChatFile(rig, 'session-file')
    })
    const listed = listedIds(rig)
    expect(listed).toEqual(['session-file'])
    const failed = new Error('disk I/O error')
    vi.spyOn(rig.store, 'reconcileOnRestart')
      .mockRejectedValueOnce(failed)
      .mockRejectedValueOnce(failed)
    await rig.host.reconcileRestartLeases()
    // An attach let through before the listing checks the leases; its own answer does not matter.
    await restTestChat(rig, 'session-other', { listed: false }).catch(() => undefined)
    expect(rig.store.getRecord('session-file')!.lease.handoffStage).toBe('recovering')

    await rig.host.catchUpMissingStatuses(listed)
    await rig.host.restoreListedFromPerChatFiles(listed)

    // Opened before the listing from its file, after its recovery: the turn reads as interrupted.
    expect(rig.host.hasSession('session-file')).toBe(true)
    expect(latestRestTestStatus(rig, 'session-file')).toMatchObject({ turnOutcome: 'interruption' })
    expect(stopOwnerProcess).toHaveBeenCalledTimes(1)
  })

  it('leaves every lease to the next attach or send when the lease check fails twice', async () => {
    const rig = await newRig()
    const stopOwnerProcess = await crashWithLiveOwner(rig, ['session-open', 'session-closed'])
    const listed = listedIds(rig)
    const failed = new Error('disk I/O error')
    const reconcile = vi
      .spyOn(rig.store, 'reconcileOnRestart')
      .mockRejectedValueOnce(failed)
      .mockRejectedValueOnce(failed)

    await startup(rig, listed)

    // No startup restore checks the leases again: each chat settles unverified, nothing stopped.
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(stopOwnerProcess).not.toHaveBeenCalled()
    expect(rig.store.getRecord('session-closed')!.lease.unreconciled).toBe(true)
    expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
      lifecycle: 'idle',
      summary: { turnOutcome: 'unconfirmed' }
    })
  })
})

/**
 * Chats whose turn was running when Orca died. The first is listed, the rest have no tab; the `live`
 * one's provider process (the last, unless named) is still up until a stop ends it. `beforeBoot`
 * runs between the crash and the next launch.
 */
async function crashWithLiveOwner(
  rig: RestTestRig,
  ids: readonly string[],
  options: { live?: string; beforeBoot?: () => Promise<void> } = {}
): Promise<ReturnType<typeof vi.fn>> {
  const leases: AgentSessionRecord['lease'][] = []
  for (const [index, sessionId] of ids.entries()) {
    const listed = index === 0 && ids.length > 1
    await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
    const { providerIdentity } = await rig.adapter.dispatch.mock.results.at(-1)!.value
    await rig.host
      .collaboratorsForTests()
      .sessions.get(sessionId)!
      .journal.appendItem(
        { ...providerIdentity, ordinal: 0 },
        { kind: 'turn', turnId: providerIdentity.turnId, state: 'running', startedAt: 10 },
        { fence: rig.store.getRecord(sessionId)!.lease.runtimeFence, turnScope: { kind: 'thread' } }
      )
    leases.push(rig.store.getRecord(sessionId)!.lease)
  }
  await rig.crash()
  for (const lease of leases) {
    await writeOlderBuildLease(rig.root, lease.sessionId, { ...lease })
  }
  await options.beforeBoot?.()
  let alive = true
  const stopOwnerProcess = vi.fn(() => {
    alive = false
  })
  rig.probeOwner.mockImplementation(async (record) =>
    alive && record.sessionId === (options.live ?? ids.at(-1))
      ? { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
      : { outcome: 'pid-absent' }
  )
  await rig.boot({ stopOwnerProcess })
  return stopOwnerProcess
}

/** Settled from the death evidence its recovery recorded: the turn reads as interrupted, not as
 *  unconfirmed, and the chat is closed again. */
function expectInterruptedAndStopped(
  rig: RestTestRig,
  sessionId: string,
  stopOwnerProcess: ReturnType<typeof vi.fn>
): void {
  expect(readTestJournalSessionStatus(rig.root, sessionId)).toMatchObject({
    lifecycle: 'idle',
    summary: { turnOutcome: 'interruption' }
  })
  expect(stopOwnerProcess).toHaveBeenCalled()
  expect(rig.store.getRecord(sessionId)!.lease).toMatchObject({
    deathEvidence: { kind: 'pid-absent' }
  })
  expect(rig.host.hasSession(sessionId)).toBe(false)
}

describe('one awaited settle covers a chat whose tab closes meanwhile (R1T-4)', () => {
  it('settles a listed chat the listed worker skips because its tab closed', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-closing')
    await rig.crash()
    await rig.boot()
    const listed = listedIds(rig)
    expect(listed).toContain('session-closing')
    await rig.host.reconcileRestartLeases()
    rig.host.seedStoredStatuses(listed)
    // The tab closes after the listing named it, before its settle runs.
    await rig.store.setSessionTabVisibility('session-closing', false)

    await rig.host.settleOwedSessions(listed)

    expect(readTestJournalSessionStatus(rig.root, 'session-closing')).toMatchObject({
      lifecycle: 'idle',
      handedOverSends: 0
    })
    expect(rig.host.hasSession('session-closing')).toBe(false)
  })
})

describe('the startup gate holds chat commands and never refuses them', () => {
  async function bootGated(gate: StructuredAgentSessionStartupGate): Promise<RestTestRig> {
    const rig = await newRig()
    await restTestChat(rig, 'session-1', { message: 'first' })
    await rig.host.flushAllStreamedEvents()
    await rig.crash()
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    return rig
  }

  it('holds a send until the settle ends, then delivers it; listing and status answer meanwhile', async () => {
    const gate = new StructuredAgentSessionStartupGate()
    const rig = await bootGated(gate)
    // The tab list and the seeded status answer while the gate is closed.
    expect(listedIds(rig)).toContain('session-1')
    rig.host.seedStoredStatuses(['session-1'])
    expect(latestRestTestStatus(rig, 'session-1')).toMatchObject({ status: 'idle' })
    const dispatched = rig.adapter.dispatch.mock.calls.length
    let answered = false
    const sent = sendRestTestMessage(rig, 'session-1', 'during startup').then((result) => {
      answered = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(answered).toBe(false)
    expect(rig.adapter.dispatch.mock.calls.length).toBe(dispatched)

    gate.openWhen(Promise.reject(new Error('settle failed')))

    expect(await sent).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(rig.adapter.dispatch.mock.calls.length).toBeGreaterThan(dispatched)
    )
  })

  it('lets held commands through at its ceiling if the settle never ends', async () => {
    const gate = new StructuredAgentSessionStartupGate(30)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rig = await bootGated(gate)

    expect(await sendRestTestMessage(rig, 'session-1', 'after the ceiling')).toMatchObject({
      ok: true
    })
    expect(gate.ready()).toBeNull()
  })
})

describe('commands held for the real startup settle never deadlock it (R2T-1)', () => {
  const CEILING_MS = 3_000

  it('lets a command issued before the settle, one during it and a healthy read through as the settle ends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rig = await newRig()
    for (const sessionId of ['session-a', 'session-b']) {
      await crashMidTurn(rig, sessionId)
    }
    await restTestChat(rig, 'session-healthy', { message: 'fine' })
    await rig.crash()
    const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    const listed = listedIds(rig)
    await rig.host.reconcileRestartLeases()
    rig.host.seedStoredStatuses(listed)
    expect(readUnsettledJournalSessionIds(db(rig)).toSorted()).toEqual(['session-a', 'session-b'])
    const started = Date.now()
    const elapsed = () => Date.now() - started

    // Before the settle: a send to a crashed chat, and the option read a chat pane fires on mount.
    const sendBefore = sendRestTestMessage(rig, 'session-a', 'during startup').then(elapsed)
    const optionsBefore = rig.host.readOptions('session-a').then(elapsed)
    const settled = rig.host.settleOwedSessions(listed)
    gate.openWhen(settled)
    // During the settle: the second crashed chat, which the settle has not reached yet.
    const optionsDuring = rig.host.readOptions('session-b').then(elapsed)
    const healthyRead = rig.host.journalSnapshot('session-healthy').then(elapsed)
    const settleEnded = await settled.then(elapsed)

    const answered = await Promise.all([sendBefore, optionsBefore, optionsDuring, healthyRead])
    expect(settleEnded).toBeLessThan(CEILING_MS / 2)
    for (const at of answered) {
      expect(at).toBeLessThan(CEILING_MS / 2)
    }
    expect(gate.ready()).toBeNull()
  }, 20_000)

  it('holds a rewind and a /clear sent straight to the host, and a read, then answers them as the settle ends', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const rig = await newRig()
    const crashed = ['session-a', 'session-b', 'session-c']
    for (const sessionId of crashed) {
      await crashMidTurn(rig, sessionId)
    }
    await rig.crash()
    const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
    gate.hold()
    await rig.boot({ commandsReady: gate.ready })
    const listed = listedIds(rig)
    await rig.host.reconcileRestartLeases()
    rig.host.seedStoredStatuses(listed)
    const opensAtBoot = crashed.map((id) => restTestOpens(rig, id))
    const started = Date.now()
    const elapsed = () => Date.now() - started

    // Neither takes the RPC's reveal first; /clear is on the chat the settle reaches last.
    const rewind = rig.host
      .rewind(REST_TEST_CALLER, rewindParams('session-a', 'missing-item'))
      .then(elapsed, elapsed)
    const clear = rig.host
      .conversationCommand(REST_TEST_CALLER, conversationCommandParams('session-b', 'clear'))
      .then(elapsed, elapsed)
    // A read opens a closed chat too, which would settle it ahead of the lease resolution.
    const read = rig.host.journalSnapshot('session-c').then(elapsed)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Held: none has opened its crashed chat ahead of the settle.
    expect(crashed.map((id) => restTestOpens(rig, id))).toEqual(opensAtBoot)
    const settled = rig.host.settleOwedSessions(listed)
    gate.openWhen(settled)
    const settleEnded = await settled.then(elapsed)

    expect(settleEnded).toBeLessThan(CEILING_MS / 2)
    for (const at of await Promise.all([rewind, clear, read])) {
      expect(at).toBeGreaterThanOrEqual(20)
      expect(at).toBeLessThan(CEILING_MS / 2)
    }
  }, 20_000)
})

function rewindParams(sessionId: string, itemId: string) {
  return {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.rewind',
        sessionId,
        fields: { itemId, expectedEpoch: 'epoch-unknown' }
      })
    },
    itemId,
    expectedEpoch: 'epoch-unknown'
  }
}

function conversationCommandParams(sessionId: string, command: 'clear') {
  return {
    envelope: {
      sessionId,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId,
        fields: { command }
      })
    },
    command
  }
}

describe('a recovery that never answers', () => {
  it('leaves that lease unverified and lets the settle go on', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() }
    const stuck = { ...agentSessionRecordFixture(), sessionId: 'session-stuck' }
    stuck.lease = { ...stuck.lease, sessionId: 'session-stuck', handoffStage: 'recovering' }
    const resolveRecovery = vi.fn(() => new Promise<boolean>(() => {}))
    const restoreListed = vi.fn(async () => undefined)
    const openDeps = {
      store: { getRecord: () => stuck, listRecords: () => [stuck] },
      journalDatabase: { readOnly: false, db: { prepare: () => ({ all: () => [] }) } },
      logger
    }
    const state = createStructuredAgentSessionStartupState({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the settle reads only the store's records and the unsettled-row query; nothing is selected, so nothing opens.
      openDeps: openDeps as unknown as StructuredAgentSessionStartupStateDeps['openDeps'],
      canSettle: (record): record is AgentSessionRecord => record !== null,
      seedStatus: vi.fn(),
      reconcile: async () => true,
      resolveRecovery,
      restoreListed,
      serialize: (_sessionId, task) => task(),
      hasSession: () => false,
      isListed: () => true,
      isDisposed: () => false,
      recoveryBudgetMs: 20
    })

    await state.settleOwedSessions([])

    expect(resolveRecovery).toHaveBeenCalledWith('session-stuck')
    expect(restoreListed).toHaveBeenCalledWith([], {
      reconcile: expect.any(Function),
      resolveRecovery: expect.any(Function)
    })
    expect(stuck.lease.handoffStage).toBe('recovering')
    expect(logger.warn).toHaveBeenCalledWith('a chat recovery outlasted startup; left unverified', {
      scope: 'startup-recovery-timeout',
      sessionId: 'session-stuck'
    })
  })
})

describe('a listed chat whose recovery never answers', () => {
  it('is opened unverified, with no second recovery beside the first, and the rest still settle', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-stuck')
    await crashMidSend(rig, 'session-closed', false)
    const lease = rig.store.getRecord('session-stuck')!.lease
    await rig.crash()
    // Its provider process was up when Orca died; the check of it answers once, then never again.
    await writeOlderBuildLease(rig.root, 'session-stuck', { ...lease })
    let answered = false
    let hung = 0
    rig.probeOwner.mockImplementation(async (record) => {
      if (record.sessionId !== 'session-stuck') {
        return { outcome: 'pid-absent' }
      }
      if (!answered) {
        answered = true
        return { outcome: 'identity-matched', matchedOn: ['spawn-token'] }
      }
      hung += 1
      return new Promise(() => {})
    })
    await rig.boot({ startupRecoveryBudgetMs: 50 })
    expect(listedIds(rig)).toEqual(['session-stuck'])

    const done = await Promise.race([
      startup(rig, listedIds(rig)).then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5_000))
    ])

    expect(done).toBe('done')
    expect(hung).toBe(1)
    expect(rig.store.getRecord('session-stuck')!.lease.handoffStage).toBe('recovering')
    expect(opened(rig, ['session-closed'])).toEqual(['session-closed'])
    expect(readTestJournalSessionStatus(rig.root, 'session-closed')).toMatchObject({
      lifecycle: 'idle'
    })
  }, 20_000)
})

describe('a stored status no settle here can clear (R2A-4)', () => {
  it('drops the row of a chat whose record is gone or whose provider this host does not serve, so the next boot selects neither', async () => {
    const rig = await newRig()
    await crashMidSend(rig, 'session-gone', false)
    await crashMidSend(rig, 'session-elsewhere', false)
    await rig.crash()
    await editPersistedTestAgentSessionStore(rig.root, (persisted) => {
      delete persisted.records['session-gone']
    })
    rig.unsupportedWorkspaceIds.add(rig.store.getRecord('session-elsewhere')!.location.workspaceId)

    await rig.boot()
    await startup(rig, listedIds(rig))

    for (const sessionId of ['session-gone', 'session-elsewhere']) {
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toBeNull()
    }
    expect(opened(rig, ['session-gone', 'session-elsewhere'])).toEqual([])

    // The obligation died: the next boot finds no row to select and opens neither chat.
    await rig.crash()
    await rig.boot()
    await startup(rig, listedIds(rig))
    for (const sessionId of ['session-gone', 'session-elsewhere']) {
      expect(readTestJournalSessionStatus(rig.root, sessionId)).toBeNull()
    }
    expect(opened(rig, ['session-gone', 'session-elsewhere'])).toEqual([])
  })
})
