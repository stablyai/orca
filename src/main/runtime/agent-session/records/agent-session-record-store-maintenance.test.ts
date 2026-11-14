import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openJournalDatabase } from '../../../native-chat/agent-session-journal/database/journal-database'
import { journalDatabasePath } from '../../../native-chat/agent-session-journal/database/journal-host-database'
import { publishJournalSessionEpoch } from '../../../native-chat/agent-session-journal/durable-rows/journal-row-table'
import { publishJournalOutcomeEpoch } from '../../../native-chat/agent-session-journal/outcomes/journal-outcome-epoch.test-fixture'
import { journalSqlLifecycleRows } from '../../../native-chat/agent-session-journal/journal-sql-reducer-rows.test-fixture'
import { JournalSqlReaderPool } from '../../../native-chat/agent-session-journal/journal-sql-reader-pool'
import { JournalSqlOwner } from '../../../native-chat/agent-session-journal/journal-sql-owner'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from '../../../native-chat/agent-session-journal/journal-sql-worker-bundle.test-fixture'
import { agentSessionRecordFixture } from '../../../native-chat/testing/agent-session-record-test-fixture'
import { storedTestAgentSessionRecord } from './agent-session-record-store-test-harness'
import {
  closeAgentSessionRecordStoreDatabase,
  openAgentSessionRecordStoreOnce,
  retireAgentSessionRecordStore
} from './agent-session-record-store-slot'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { claudeAndCodexAgents } from '../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router.test-fixture'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestSendParams
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlActivity } from '../../../native-chat/agent-session-journal/journal-sql-activity'

const observeIdleWait = vi.hoisted(() => vi.fn<(idle: Promise<void>) => void>())
vi.mock(
  '../../../native-chat/agent-session-journal/journal-sql-activity',
  async (importOriginal) => {
    const original = await importOriginal<{ JournalSqlActivity: new () => JournalSqlActivity }>()
    return {
      JournalSqlActivity: vi.fn(function () {
        const activity = new original.JournalSqlActivity()
        const wait = activity.waitForIdle
        activity.waitForIdle = (signal) => {
          const idle = wait(signal)
          observeIdleWait(idle)
          return idle
        }
        return activity
      })
    }
  }
)

let root: string | undefined
let host: StructuredAgentSessionHost | undefined
const releases: (() => void)[] = []
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  await retireAgentSessionRecordStore(async (opened) => {
    await host?.flushAllStreamedEvents()
    await closeAgentSessionRecordStoreDatabase(opened?.journalDatabase)
  })
  host = undefined
  vi.restoreAllMocks()
  observeIdleWait.mockReset()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

function barrier() {
  const pending = Promise.withResolvers<void>()
  releases.push(pending.resolve)
  return pending
}

async function profile() {
  root = await mkdtemp(join(tmpdir(), 'orca-slot-maintenance-'))
  const { db } = openJournalDatabase(journalDatabasePath(root))
  try {
    publishJournalSessionEpoch(db, { sessionId: 'unopened', workspaceId: 'workspace' }, 'epoch')
    publishJournalOutcomeEpoch(db, 'unopened', 'epoch', journalSqlLifecycleRows())
    const record = storedTestAgentSessionRecord(
      agentSessionRecordFixture({ sessionId: 'record-only' })
    )
    db.prepare('INSERT INTO agent_session_records VALUES(?,?)').run(
      'record-only',
      JSON.stringify(record)
    )
  } finally {
    db.close()
  }
  const discovery = barrier()
  const entered = Promise.withResolvers<void>()
  const converted = Promise.withResolvers<void>()
  const atIdleGate = Promise.withResolvers<void>()
  const order: string[] = []
  observeIdleWait.mockImplementationOnce((idle) => {
    order.push('waiting')
    void idle.then(() => order.push('idle'))
    atIdleGate.resolve()
  })
  const read = JournalSqlReaderPool.prototype.database
  let held = false
  vi.spyOn(JournalSqlReaderPool.prototype, 'database').mockImplementation(async function (
    this: JournalSqlReaderPool,
    operation
  ) {
    if (operation.kind === 'retired-heads' && !held) {
      held = true
      entered.resolve()
      await discovery.promise
    }
    if (operation.kind === 'sessions') {
      if (operation.after === null) {
        order.push('sessions')
      } else {
        converted.resolve()
      }
    }
    return read.call(this, operation)
  })
  const opened = await openAgentSessionRecordStoreOnce({
    stateDirectory: root,
    hostId: 'local',
    legacySessionTabIds: [],
    logger: createStructuredAgentSessionLogger(),
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceTick: () => {}
  })
  await entered.promise
  const history = () =>
    opened.journalDatabase.readers.domainHistory({ sessionId: 'unopened', direction: 'tail' })
  return { ...opened, discovery, converted, history, atIdleGate, order }
}

it('opens the startup/watch record slot without awaiting discovery, then converts an unopened chat without a host', async () => {
  const profileState = await profile()
  await expect(profileState.history()).rejects.toThrow('without domain state')
  profileState.discovery.resolve()
  await profileState.converted.promise
  expect(await profileState.history()).toMatchObject({
    ok: true,
    page: { sessionId: 'unopened', liveCursor: { epoch: 'epoch', sequence: 16 } }
  })
})

it('returns a fork capture refusal after releasing custody without waiting for held profile discovery', async () => {
  const profileState = await profile()
  await expect(
    profileState.journalDatabase.serialize('record-only', () =>
      profileState.journalDatabase.prepareForkCopy({
        source: {
          sessionId: 'record-only',
          throughItemId: 'missing',
          retained: 'changed',
          capability: 'checkpoint',
          location: profileState.store.getRecord('record-only')!.location,
          submissionsToken: null
        }
      })
    )
  ).rejects.toThrow('agent_session_operation_invalid')
  profileState.discovery.resolve()
  await profileState.converted.promise
  expect(await profileState.history()).toMatchObject({ ok: true })
})

it('pauses conversion for pre-host record effects until the write settles', async () => {
  const profileState = await profile()
  const effects = JournalSqlOwner.prototype.effects
  const admitted = Promise.withResolvers<void>()
  const finish = barrier()
  vi.spyOn(JournalSqlOwner.prototype, 'effects').mockImplementationOnce(async function (
    this: JournalSqlOwner,
    input
  ) {
    admitted.resolve()
    await finish.promise
    return effects.call(this, input)
  })
  const write = profileState.store.setConversationName('record-only', 'updated')
  await admitted.promise
  profileState.discovery.resolve()
  await profileState.atIdleGate.promise
  profileState.order.push('owner ended')
  finish.resolve()
  await write
  expect(profileState.store.getRecord('record-only')?.conversationName).toBe('updated')
  await profileState.converted.promise
  expect(profileState.order).toEqual(['waiting', 'owner ended', 'idle', 'sessions'])
  expect(await profileState.history()).toMatchObject({ ok: true })
})

it('releases pre-host record activity when the write rejects', async () => {
  const profileState = await profile()
  const admitted = Promise.withResolvers<void>()
  const finish = barrier()
  vi.spyOn(JournalSqlOwner.prototype, 'effects').mockImplementationOnce(async () => {
    admitted.resolve()
    await finish.promise
    throw new Error('record write refused')
  })
  const write = profileState.store.setConversationName('record-only', 'updated')
  const result = write.catch((error: unknown) => error)
  await admitted.promise
  profileState.discovery.resolve()
  await profileState.atIdleGate.promise
  profileState.order.push('owner ended')
  finish.resolve()
  expect(await result).toEqual(new Error('record write refused'))
  await profileState.converted.promise
  expect(profileState.order).toEqual(['waiting', 'owner ended', 'idle', 'sessions'])
  expect(await profileState.history()).toMatchObject({ ok: true })
})

async function liveProfile() {
  const profileState = await profile()
  let activityReadSettled = Promise.resolve()
  const hold = profileState.journalDatabase.holdActivity.bind(profileState.journalDatabase)
  vi.spyOn(profileState.journalDatabase, 'holdActivity').mockImplementation(() => {
    const release = hold()
    const settled = Promise.withResolvers<void>()
    activityReadSettled = settled.promise
    return () => {
      release()
      settled.resolve()
    }
  })
  const acquired = Promise.withResolvers<void>()
  const acquire = barrier()
  const opening = Promise.withResolvers<void>()
  const ready = barrier()
  let events: Parameters<StructuredAgentSessionAdapter['acquire']>[0]['events']
  const adapter: StructuredAgentSessionAdapter = {
    acquire: async (input) => {
      events = input.events
      acquired.resolve()
      await acquire.promise
      return {
        acquisitionGeneration: 'generation',
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: input.spawnToken
        },
        link: {
          linkId: 'link',
          handle: codexProviderHandle(HOST_TEST_THREAD),
          origin: 'created',
          mintedAtFence: input.fence,
          observedAt: 1_800_000_000_000
        }
      }
    },
    open: async () => {
      opening.resolve()
      await ready.promise
      return { reportedOptions: { model: '' } }
    },
    dispatch: async () => {
      throw new Error('no user dispatch expected')
    },
    closeSession: async () => true,
    cancelTurn: async () => ({ cancelled: true }),
    answerPrompt: async ({ commit }) => commit(),
    setOption: async () => undefined,
    releaseAcquisition: async () => true,
    acknowledgeSessionRelease: () => {}
  }
  host = new StructuredAgentSessionHost({
    ...profileState,
    agents: claudeAndCodexAgents(),
    adapter,
    logger: createStructuredAgentSessionLogger(),
    claimKeyId: 'key',
    mintSpawnToken: () => 'spawn',
    now: () => HOST_TEST_NOW,
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    idleSweep: { intervalMs: 3_600_000, idleMs: () => null }
  })
  return {
    profileState,
    acquired,
    acquire,
    opening,
    ready,
    events: () => events!,
    host,
    activityReadsSettled: () => activityReadSettled
  }
}

it('pauses conversion while a direct attach has not indexed its child', async () => {
  const live = await liveProfile()
  const attached = live.host.attach({ callerKey: 'client' }, hostTestAttachParams(null))
  await live.acquired.promise
  live.profileState.discovery.resolve()
  await live.profileState.atIdleGate.promise
  live.profileState.order.push('owner ended')
  live.acquire.resolve()
  live.ready.resolve()
  expect(await attached).toMatchObject({ ok: true })
  await live.profileState.converted.promise
  expect(live.profileState.order).toEqual(['waiting', 'owner ended', 'idle', 'sessions'])
  expect(await live.profileState.history()).toMatchObject({ ok: true })
})

it('pauses conversion while a registered client start waits for its provider to open', async () => {
  const live = await liveProfile()
  expect(await live.host.create({ callerKey: 'client' }, hostTestAttachParams(null))).toMatchObject(
    { ok: true }
  )
  live.host.deps.adapter.dispatch = async () => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'provider-turn',
      ordinal: 51
    }
  })
  const sent = await live.host.send({ callerKey: 'client' }, hostTestSendParams('hello'))
  if (!sent.ok) {
    throw new Error('the send was refused')
  }
  await live.acquired.promise
  live.acquire.resolve()
  await live.opening.promise
  const { runtimeState, conversationDelivery } = live.host.collaboratorsForTests()
  const start = runtimeState.startFlights.get(HOST_TEST_SESSION)!
  live.profileState.discovery.resolve()
  await live.profileState.atIdleGate.promise
  live.profileState.order.push('owner ended')
  live.ready.resolve()
  expect(await start.outcome).toEqual({ ok: true })
  await live.host.waitForSendSettlement(HOST_TEST_SESSION, sent.value.clientMessageId)
  await conversationDelivery.loop.wake(HOST_TEST_SESSION)
  await live.profileState.converted.promise
  expect(live.profileState.order).toEqual(['waiting', 'owner ended', 'idle', 'sessions'])
  expect(await live.profileState.history()).toMatchObject({ ok: true })
})

it('keeps provider work active when its obsolete registered start finishes', async () => {
  const live = await liveProfile()
  const { profileState } = live
  expect(await live.host.create({ callerKey: 'client' }, hostTestAttachParams(null))).toMatchObject(
    { ok: true }
  )
  live.host.deps.adapter.dispatch = async () => ({
    state: 'accepted',
    providerIdentity: {
      provider: 'codex',
      threadId: HOST_TEST_THREAD,
      turnId: 'provider-turn',
      ordinal: 51
    }
  })
  const sent = await live.host.send({ callerKey: 'client' }, hostTestSendParams('hello'))
  if (!sent.ok) {
    throw new Error('the send was refused')
  }
  await live.acquired.promise
  live.acquire.resolve()
  await live.opening.promise
  const { sessions, runtimeState, conversationDelivery } = live.host.collaboratorsForTests()
  const child = sessions.get(HOST_TEST_SESSION)!.child!
  const readiness = runtimeState.startupAttempts.readiness(HOST_TEST_SESSION, child)!
  const start = runtimeState.startFlights.get(HOST_TEST_SESSION)!
  const identity = {
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId: 'provider-turn',
    ordinal: 50
  }
  live
    .events()
    .appendItem(
      identity,
      { kind: 'turn', turnId: 'provider-turn', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await live.host.flushStreamedEvents(HOST_TEST_SESSION)
  profileState.discovery.resolve()
  await profileState.atIdleGate.promise
  start.abort()
  expect(await start.outcome).toMatchObject({ ok: false, aborted: true })
  profileState.order.push('obsolete start ended')
  live.ready.resolve()
  expect(await readiness.wait()).toBe('ready')
  await conversationDelivery.loop.wake(HOST_TEST_SESSION)
  await live.activityReadsSettled()
  profileState.order.push('owner ended')
  live
    .events()
    .appendItem(
      identity,
      { kind: 'turn', turnId: 'provider-turn', state: 'completed', completedAt: 1_800_000_000_100 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await live.host.flushStreamedEvents(HOST_TEST_SESSION)
  await live.host.waitForSendSettlement(HOST_TEST_SESSION, sent.value.clientMessageId)
  await conversationDelivery.loop.wake(HOST_TEST_SESSION)
  await profileState.converted.promise
  expect(profileState.order).toEqual([
    'waiting',
    'obsolete start ended',
    'owner ended',
    'idle',
    'sessions'
  ])
  expect(await profileState.history()).toMatchObject({ ok: true })
})

it('keeps a real client start and provider turn active across stale exits, then converts with the same ready Never child', async () => {
  const live = await liveProfile()
  const { profileState } = live
  const identity = {
    provider: 'codex' as const,
    threadId: HOST_TEST_THREAD,
    turnId: 'provider-turn',
    ordinal: 50
  }
  live.host.deps.adapter.liveTurnId = () => 'provider-turn'
  const dispatched = Promise.withResolvers<void>()
  const finishDispatch = barrier()
  live.host.deps.adapter.dispatch = async () => {
    live
      .events()
      .appendItem(
        identity,
        { kind: 'turn', turnId: 'provider-turn', state: 'running' },
        { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    dispatched.resolve()
    await finishDispatch.promise
    return { state: 'accepted', providerIdentity: { ...identity, ordinal: 51 } }
  }
  expect(await live.host.create({ callerKey: 'client' }, hostTestAttachParams(null))).toMatchObject(
    { ok: true }
  )
  const sent = await live.host.send({ callerKey: 'client' }, hostTestSendParams('hello'))
  expect(sent).toMatchObject({ ok: true })
  await live.acquired.promise
  live.acquire.resolve()
  await live.opening.promise
  const { sessions, runtimeState, lifetime, conversationDelivery } =
    live.host.collaboratorsForTests()
  const child = sessions.get(HOST_TEST_SESSION)!.child!
  const readiness = runtimeState.startupAttempts.readiness(HOST_TEST_SESSION, child)!
  live.ready.resolve()
  expect(await readiness.wait()).toBe('ready')
  await dispatched.promise
  await live.host.flushStreamedEvents(HOST_TEST_SESSION)
  finishDispatch.resolve()
  if (!sent.ok) {
    throw new Error('the send was refused')
  }
  await live.host.waitForSendSettlement(HOST_TEST_SESSION, sent.value.clientMessageId)
  await conversationDelivery.loop.wake(HOST_TEST_SESSION)
  await live.activityReadsSettled()
  profileState.discovery.resolve()
  await profileState.atIdleGate.promise
  await live.host.handleAdapterEvent({
    type: 'ended',
    sessionId: HOST_TEST_SESSION,
    fence: child.fence,
    acquisitionGeneration: 'old-generation',
    cause: 'unexpected-exit',
    reason: 'old child exited'
  })
  profileState.order.push('owner ended')
  live
    .events()
    .appendItem(
      identity,
      { kind: 'turn', turnId: 'provider-turn', state: 'completed', completedAt: 1_800_000_000_100 },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  await live.host.flushStreamedEvents(HOST_TEST_SESSION)
  await profileState.converted.promise
  expect(profileState.order).toEqual(['waiting', 'owner ended', 'idle', 'sessions'])
  await lifetime.idleSweep.tick()
  expect(sessions.get(HOST_TEST_SESSION)?.child).toBe(child)
  expect(await profileState.history()).toMatchObject({ ok: true })
})
