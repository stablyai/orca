import { StructuredAgentRegistry } from './structured-agent-registry'
import { acpLaunchSpecFor } from '../../acp/acp-launch-specs'
import { acpStructuredAgentDefinition } from '../../acp/acp-structured-agent-definitions'
import { AcpBackgroundTaskTimeline } from '../../acp/acp-background-task-timeline'
import { createProviderTimelineAssembler } from '../agent-session-timeline/provider-timeline-assembler'
import { providerTimelineSink } from '../agent-session-timeline/provider-timeline-plan'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentTurnTimings
} from '../../../shared/structured-agent-session-turn-timing'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_NOW,
  hostTestAttachParams
} from './structured-agent-session-host-test-data'
import {
  createRestTestRig,
  REST_TEST_CALLER,
  restTestSend,
  REST_TEST_SESSION as SESSION,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'

const LAST_CHUNK_AT = HOST_TEST_NOW + 5_500
const CONNECTION_CLOSED_AT = HOST_TEST_NOW + 60_000
const RESTARTED_AT = HOST_TEST_NOW + 3_600_000

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({ idleSweep: { intervalMs: 3_600_000 } })
  vi.spyOn(Date, 'now').mockImplementation(() => rig.clock.now)
  const spec = acpLaunchSpecFor('grok')
  if (!spec) {
    throw new Error('ACP agent definition absent')
  }
  const definition = acpStructuredAgentDefinition(spec)
  // The rig adapter has no compact; this recovery never compacts.
  rig.host.deps.agents = new StructuredAgentRegistry([
    {
      definition: { ...definition, capabilities: { ...definition.capabilities, compact: false } },
      adapter: rig.host.deps.adapter
    }
  ])
  rig.adapter.acquire.mockImplementation(async ({ fence, spawnToken }) => ({
    acquisitionGeneration: 'acp-generation',
    process: { hostId: 'local', pid: 4242, processStartTimeMs: 1_700_000_000_000, spawnToken },
    link: {
      linkId: `link-${fence}`,
      handle: { transport: 'acp', agent: 'grok', nativeId: 'acp-session' },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: rig.clock.now
    }
  }))
  rig.adapter.dispatch.mockImplementation(async ({ clientMessageId }) => ({
    state: 'accepted',
    providerIdentity: { provider: 'orca', clientMessageId }
  }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rig.dispose()
  closeTestJournalHostDatabases()
})

/** Drops the old host without an exit callback or graceful turn settlement. */
async function restartAfterCrash(): Promise<void> {
  const old = rig.host
  old.stopDelivery()
  const { lifetime, runtimeState, sessions } = old.collaboratorsForTests()
  lifetime.idleSweep.dispose()
  await runtimeState.stopLeaseRenewal()
  runtimeState.currentEventSink(SESSION)?.close()
  await sessions.get(SESSION)?.journal.close()
  closeTestJournalHostDatabases()
  rig.clock.now = RESTARTED_AT
  rig.store = await openTestAgentSessionRecordStore(rig.root)
  rig.host = new StructuredAgentSessionHost({
    ...old.deps,
    store: rig.store,
    journalDatabase: openTestJournalHostDatabase(rig.root),
    now: () => RESTARTED_AT
  })
}

async function beginTurn(workspaceKind: 'git-worktree' | 'folder') {
  const attached = await rig.host.attach(
    REST_TEST_CALLER,
    hostTestAttachParams(null, {
      provider: 'grok',
      agent: 'grok',
      providerHandle: undefined,
      location: { ...HOST_TEST_LOCATION, workspaceKind },
      accountHome: { variable: 'GROK_HOME', path: rig.root }
    })
  )
  if (!attached.ok) {
    throw new Error('attach refused')
  }
  const sent = await rig.host.send(
    REST_TEST_CALLER,
    restTestSend('background work', attached.fence)
  )
  if (!sent.ok) {
    throw new Error('send refused')
  }
  await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
  const events = rig.adapter.acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('event sink absent')
  }
  expect(rig.store.getRecord(SESSION)?.provider).toBe('grok')
  return events
}

describe.each([
  ['journal-open', false],
  ['session-end', false],
  ['session-end', true]
] as const)('%s recovery with buffered output: %s', (recovery, bufferedOutput) => {
  it.each(['git-worktree', 'folder'] as const)(
    'excludes ACP background-task recovery in a %s workspace',
    async (workspaceKind) => {
      const events = await beginTurn(workspaceKind)
      const sink = providerTimelineSink(events)
      if (!sink) {
        throw new Error('timeline sink absent')
      }
      const assembler = createProviderTimelineAssembler({
        sink,
        sessionId: SESSION,
        agent: 'grok',
        generation: 'acp-generation',
        namespace: 'acp-session',
        schedule: () => () => {}
      })
      assembler.apply({ type: 'turn.open', turn: 'acp-turn', at: HOST_TEST_NOW })
      rig.clock.now = LAST_CHUNK_AT
      const tasks = new AcpBackgroundTaskTimeline(() => undefined)
      for (const event of tasks.translate(
        [
          {
            taskId: 'task-1',
            kind: 'command',
            label: 'sleep 20',
            state: 'working',
            startedAt: HOST_TEST_NOW
          }
        ],
        { turn: 'acp-turn' }
      )) {
        expect(assembler.apply(event).admission).toMatchObject({ accepted: true })
      }
      assembler.flush()
      await rig.host.flushStreamedEvents(SESSION)
      if (bufferedOutput) {
        expect(
          assembler.apply({
            type: 'text.delta',
            item: { stream: 'tail' },
            channel: 'assistant',
            text: 'buffered provider output'
          }).admission
        ).toMatchObject({ accepted: true })
      }
      if (recovery === 'session-end') {
        rig.clock.now = CONNECTION_CLOSED_AT
        expect(
          assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } }).admission
        ).toMatchObject({ accepted: true })
        await rig.host.flushStreamedEvents(SESSION)
      }
      assembler.dispose()
      const journal = rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal
      if (!journal) {
        throw new Error('journal absent')
      }
      const completedAt = bufferedOutput ? CONNECTION_CLOSED_AT : LAST_CHUNK_AT
      expect(journal.lastProviderActivityAt(1)).toBe(completedAt)
      await restartAfterCrash()
      await rig.host.restoreReadableSessions()
      const snapshot = await rig.host.journalSnapshot(SESSION)
      const background = snapshot.items.find(
        (item) =>
          item.body.kind === 'message' &&
          item.body.blocks.some((block) => block.type === 'background-task')
      )
      expect(background?.body).toMatchObject({
        blocks: expect.arrayContaining([expect.objectContaining({ state: 'unverifiable' })])
      })
      const turn = snapshot.items.map((item) => readAgentJournalTurn(item.body)).find(Boolean)
      expect(turn).toMatchObject({ state: 'interrupted', completedAt })
      const [timing] = selectStructuredAgentTurnTimings(snapshot.items).values()
      expect(completedStructuredAgentTurnSeconds(timing)).toBe(bufferedOutput ? 60 : 5)
      expect(
        rig.host.collaboratorsForTests().sessions.get(SESSION)?.journal.lastProviderActivityAt(1)
      ).toBe(completedAt)
      await restartAfterCrash()
      await rig.host.restoreReadableSessions()
      expect((await rig.host.journalSnapshot(SESSION)).items).toEqual(snapshot.items)
    }
  )
})
