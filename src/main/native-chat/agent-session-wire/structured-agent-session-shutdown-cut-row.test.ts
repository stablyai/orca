// A quit or update that cuts a reply writes one row saying so, in the words every client already
// prints, with the cause beside them. A turn that finished, a person's Stop and an idle eviction
// write none.

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle
} from '../../../shared/agent-session-journal-types'
import { readAgentSessionOrcaStop } from '../../../shared/agent-session-orca-stop'
import { withNativeChatCutTurnNotices } from '../../../shared/native-chat-cut-turn-notice'
import { latestNativeChatOrcaStopCut } from '../../../shared/native-chat-orca-stop-cut'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session-recovery-capsule'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  agentSessionRuntimeIncarnation,
  beginAgentSessionRuntimeIncarnationForTest
} from '../../runtime/agent-session-runtime-attribution'
import { recordAgentSessionRuntimeEnd } from '../../runtime/agent-session-runtime-end-record'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { claudeAndCodexDeclared } from './structured-agent-session-adapter-router-test-support'

const CUT_TURN = { provider: 'codex' as const, threadId: THREAD, turnId: 'cut-turn', ordinal: 1 }
const LEGACY_TEXT =
  'Codex stopped while this response was in progress. You can continue in this conversation.'

let host: StructuredAgentSessionHost
/** How the provider ends its open turn as it is stopped. */
let providerEnd: Pick<AgentJournalTurnLifecycle, 'state' | 'outcome' | 'completedAt'>

beforeEach(() => {
  const state = hostTestState()
  providerEnd = { state: 'interrupted', completedAt: HOST_TEST_NOW }
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store: state.store,
    adapter: {
      ...adapter(),
      closeSession: async () => {
        const events = state.acquire.mock.calls.at(-1)?.[0]?.events
        if (!events) {
          throw new Error('missing provider event sink')
        }
        events.appendItem(
          CUT_TURN,
          {
            kind: 'turn',
            turnId: 'cut-turn',
            startedAt: 1_000,
            requestedAt: 1_000,
            ...providerEnd
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return true
      }
    },
    journalDatabase: openTestJournalHostDatabase(state.root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(state.root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    now: () => HOST_TEST_NOW
  })
  replaceHostTestState({ store: state.store, host })
})

async function runningTurn(): Promise<void> {
  await attach()
  const events = hostTestState().acquire.mock.calls[0]?.[0].events
  if (!events) {
    throw new Error('missing provider event sink')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'cut-turn', ordinal: 0 },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  events.appendItem(
    CUT_TURN,
    { kind: 'turn', turnId: 'cut-turn', state: 'running', startedAt: 1_000, requestedAt: 1_000 },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
}

/** The Orca that ran the turn dies with no teardown; the next one starts over the same files and
 *  finds the turn's owner gone. */
async function restartAfterDeath(): Promise<void> {
  const { root } = hostTestState()
  beginAgentSessionRuntimeIncarnationForTest()
  const store = await openTestAgentSessionRecordStore(root)
  host = new StructuredAgentSessionHost({
    agents: claudeAndCodexDeclared(),
    logger: createStructuredAgentSessionLogger(),
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(root),
    recoveryCapsule: new AgentSessionRecoveryCapsule(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner: async () => ({ outcome: 'pid-absent' }),
    now: () => HOST_TEST_NOW + 60_000
  })
  replaceHostTestState({ store, host })
  await host.reconcileRestartLeases()
}

async function reread() {
  await host.collaboratorsForTests().restoreReadableSessions([SESSION])
  const { items } = await host.journalSnapshot(SESSION)
  const turnItemId = items.find((item) => item.body.kind === 'turn')?.itemId
  const stopRows = items.filter(
    (item) =>
      item.body.kind === 'status' && readAgentSessionOrcaStop(item.body.orcaStop) !== undefined
  )
  const readerErrors = withNativeChatCutTurnNotices(items, { agentName: 'Codex' }).flatMap(
    (item) => (item.body.kind === 'status' && item.body.tone === 'error' ? [item.body.text] : [])
  )
  return { items, turnItemId, stopRows, readerErrors }
}

describe('the row a quit writes for the reply it cut', () => {
  it.each(['update', 'quit'] as const)('names a %s on the cut turn, once', async (trigger) => {
    await runningTurn()

    await host.flushAllStreamedEvents({ trigger })

    const { items, turnItemId, stopRows, readerErrors } = await reread()
    expect(stopRows).toHaveLength(1)
    const [row] = stopRows
    expect(row?.body).toMatchObject({
      kind: 'status',
      text: LEGACY_TEXT,
      tone: 'error',
      failure: { kind: 'providerExited' },
      presentation: 'orca-stop',
      orcaStop: { cause: trigger }
    })
    expect(row?.turnScope).toEqual({ kind: 'turn', turnItemId })
    // A client that reads no cause still prints exactly one row for the cut, in today's words.
    expect(readerErrors).toEqual([LEGACY_TEXT])
    expect(latestNativeChatOrcaStopCut(items, [])).toEqual({ turnItemId, cause: trigger })
  })

  it('writes nothing for a turn the provider finished during the stop', async () => {
    providerEnd = { state: 'completed', outcome: 'success', completedAt: 1_500 }
    await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'update' })

    const { stopRows, readerErrors } = await reread()
    expect(stopRows).toEqual([])
    expect(readerErrors).toEqual([])
  })

  it("writes nothing for a turn a person's Stop already ended", async () => {
    providerEnd = { state: 'interrupted', outcome: 'cancellation', completedAt: 1_500 }
    await runningTurn()

    await host.flushAllStreamedEvents({ trigger: 'update' })

    const { stopRows } = await reread()
    expect(stopRows).toEqual([])
  })

  it('never calls an idle eviction a restart', async () => {
    await runningTurn()

    await host.close(SESSION, 'evict')

    const { items, stopRows, readerErrors } = await reread()
    expect(stopRows).toEqual([])
    // The cut keeps today's derived notice, and offers no Continue.
    expect(readerErrors).toEqual([LEGACY_TEXT])
    expect(latestNativeChatOrcaStopCut(items, [])).toBeNull()
  })
})

describe('the row a restart writes for a reply its Orca died in', () => {
  it('says Orca stopped unexpectedly when the Orca before began no quit', async () => {
    await runningTurn()

    await restartAfterDeath()

    const { items, turnItemId, stopRows, readerErrors } = await reread()
    expect(stopRows).toHaveLength(1)
    expect(stopRows[0]?.body).toMatchObject({
      text: LEGACY_TEXT,
      orcaStop: { cause: 'crash' }
    })
    expect(readerErrors).toEqual([LEGACY_TEXT])
    expect(latestNativeChatOrcaStopCut(items, [])).toEqual({ turnItemId, cause: 'crash' })
  })

  it('names the update an unfinished quit began, never a crash', async () => {
    await runningTurn()
    // The quit recorded its end, then died before it stopped the agent.
    recordAgentSessionRuntimeEnd('update', HOST_TEST_NOW)

    await restartAfterDeath()

    const { stopRows } = await reread()
    expect(stopRows.map((row) => row.body)).toMatchObject([{ orcaStop: { cause: 'update' } }])
  })

  it('names no cause when the Orca before left no record of itself', async () => {
    await runningTurn()
    await rm(join(hostTestState().root, 'agent-session-runtimes'), { recursive: true, force: true })

    await restartAfterDeath()

    const { stopRows, readerErrors } = await reread()
    expect(stopRows).toEqual([])
    // The cut keeps today's words.
    expect(readerErrors).toEqual([LEGACY_TEXT])
  })
})

describe('an agent this Orca runs', () => {
  it('is recorded as held by this runtime', async () => {
    await runningTurn()
    expect(hostTestState().store.getRecord(SESSION)?.lease.ownerProcess?.runtime).toBe(
      agentSessionRuntimeIncarnation()
    )
  })

  it('names no Orca cause when the agent dies while Orca runs', async () => {
    await runningTurn()
    const child = host.collaboratorsForTests().sessions.get(SESSION)!.child!

    await host.handleAdapterEvent({
      type: 'ended',
      sessionId: SESSION,
      reason: 'killed',
      cause: 'unexpected-exit',
      fence: child.fence,
      acquisitionGeneration: child.generation!
    })

    await vi.waitFor(() =>
      expect(hostTestState().store.getRecord(SESSION)?.lease.deathEvidence).toMatchObject({
        kind: 'exit-observed'
      })
    )
    expect(hostTestState().store.getRecord(SESSION)?.lease.deathEvidence).not.toHaveProperty(
      'runtimeEnd'
    )
    const { stopRows } = await reread()
    expect(stopRows).toEqual([])
  })
})
