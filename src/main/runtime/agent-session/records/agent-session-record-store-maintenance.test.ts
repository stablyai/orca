import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
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
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
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
  hostTestAttachParams
} from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'

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
    if (operation.kind === 'sessions' && operation.after !== null) {
      converted.resolve()
    }
    return read.call(this, operation)
  })
  const opened = await openAgentSessionRecordStoreOnce({
    stateDirectory: root,
    hostId: 'local',
    legacySessionTabIds: [],
    logger: createStructuredAgentSessionLogger(),
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath()
  })
  await entered.promise
  const history = () =>
    opened.journalDatabase.readers.domainHistory({ sessionId: 'unopened', direction: 'tail' })
  // Both the maintenance continuation and its idle boundary get their scheduled turn.
  const stillUnconverted = async () => {
    await setImmediate()
    await setImmediate()
    await expect(history()).rejects.toThrow('without domain state')
  }
  return { ...opened, discovery, converted, history, stillUnconverted }
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

it.each([false, true])(
  'pauses conversion for pre-host record effects and releases activity after settlement (reject=%s)',
  async (reject) => {
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
      if (reject) {
        throw new Error('record write refused')
      }
      return effects.call(this, input)
    })
    const write = profileState.store.setConversationName('record-only', 'updated')
    const result = write.catch((error: unknown) => error)
    await admitted.promise
    profileState.discovery.resolve()
    await profileState.stillUnconverted()
    finish.resolve()
    if (reject) {
      expect(await result).toEqual(new Error('record write refused'))
    } else {
      await result
      expect(profileState.store.getRecord('record-only')?.conversationName).toBe('updated')
    }
    await profileState.converted.promise
    expect(await profileState.history()).toMatchObject({ ok: true })
  }
)

it('pauses for direct attach, registered starts and provider turns, then converts while the same Never child stays resident', async () => {
  const profileState = await profile()
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
  const attached = host.attach({ callerKey: 'client' }, hostTestAttachParams(null))
  await Promise.race([
    acquired.promise,
    attached.then((answer) => {
      throw new Error(`attach ended before acquiring: ${JSON.stringify(answer)}`)
    })
  ])
  profileState.discovery.resolve()
  await profileState.stillUnconverted()
  acquire.resolve()
  expect(await attached).toMatchObject({ ok: true })
  await opening.promise
  const { sessions, runtimeState, lifetime } = host.collaboratorsForTests()
  const child = sessions.get(HOST_TEST_SESSION)!.child!
  runtimeState.startFlights.register(HOST_TEST_SESSION, {
    attemptId: 'old',
    abort: () => {},
    outcome: Promise.resolve({ ok: true })
  })
  runtimeState.startFlights.register(HOST_TEST_SESSION, {
    attemptId: 'current',
    abort: () => {},
    outcome: Promise.resolve({ ok: true })
  })
  ready.resolve()
  await vi.waitFor(() => expect(child.phase).toBe('ready'))
  runtimeState.startFlights.end(HOST_TEST_SESSION, 'old')
  await profileState.stillUnconverted()
  events!.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'provider-turn', ordinal: 50 },
    { kind: 'turn', turnId: 'provider-turn', state: 'running' },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  runtimeState.startFlights.end(HOST_TEST_SESSION, 'current')
  await host.handleAdapterEvent({
    type: 'ended',
    sessionId: HOST_TEST_SESSION,
    fence: child.fence,
    acquisitionGeneration: 'old-generation',
    cause: 'unexpected-exit',
    reason: 'old child exited'
  })
  await profileState.stillUnconverted()
  events!.appendItem(
    { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'provider-turn', ordinal: 50 },
    { kind: 'turn', turnId: 'provider-turn', state: 'completed', completedAt: 1_800_000_000_100 },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(HOST_TEST_SESSION)
  await profileState.converted.promise
  await lifetime.idleSweep.tick()
  expect(sessions.get(HOST_TEST_SESSION)?.child).toBe(child)
  expect(await profileState.history()).toMatchObject({ ok: true })
})
