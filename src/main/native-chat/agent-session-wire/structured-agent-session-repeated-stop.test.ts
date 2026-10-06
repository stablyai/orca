// A Stop writes its one note only when it stopped something, keyed by the turn it stopped: a repeated
// Stop, however late and from whichever client, rewrites that row or writes nothing.

import { beforeEach, describe, expect, it, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentJournalTurnLifecycleState } from '../../../shared/agent-session-journal-types'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { startAgent } from './structured-agent-session-restart-interruption-test-harness'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'

const REQUESTED = 'Cancellation requested.'

let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']>

beforeEach(() => {
  ;({ host, acquire, cancelTurn } = hostTestState())
})

function stopTurn(turnId = 'turn-1') {
  return host.cancel(CALLER, { envelope: envelope('agentSession.cancel', { turnId }), turnId })
}

/** The provider's record of turn-1, as its translator writes it. */
async function turn(state: AgentJournalTurnLifecycleState): Promise<void> {
  const events = acquire.mock.calls.at(-1)?.[0].events
  if (!events) {
    throw new Error('turn requires an acquired session')
  }
  events.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 900 },
    { kind: 'turn', turnId: 'turn-1', state },
    { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  await host.flushStreamedEvents(SESSION)
}

async function statusRows(): Promise<string[]> {
  return (await host.journalSnapshot(SESSION)).items.flatMap((item) =>
    item.body.kind === 'status' ? [item.body.text] : []
  )
}

describe('a Stop pressed again', () => {
  it('writes nothing once the first Stop has settled, however late it arrives', async () => {
    await attach()
    await turn('running')
    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: true } })
    await turn('interrupted')
    // The provider has no turn left to stop.
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await statusRows()).toEqual([REQUESTED])
  })

  it('adds one row for two Stops at once, whatever the provider says to the second', async () => {
    await attach()
    await turn('running')
    const [first, second] = await Promise.all([stopTurn(), stopTurn()])

    expect(first).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(second).toMatchObject({ ok: true })
    expect(await statusRows()).toEqual([REQUESTED])
  })

  it('naming no turn, rewrites the row of the turn running, as a Stop naming it does', async () => {
    await attach()
    await turn('running')
    const unnamed = () => host.cancel(CALLER, { envelope: envelope('agentSession.cancel', {}) })
    expect(await unnamed()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await unnamed()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(await statusRows()).toEqual([REQUESTED])
  })

  it('writes nothing when neither Stop found anything to stop', async () => {
    await attach()
    await turn('running')
    await turn('completed')
    cancelTurn.mockResolvedValue({ cancelled: false })

    await stopTurn()
    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await statusRows()).toEqual([])
  })

  it('writes nothing more on a restarted host', async () => {
    const { root, store } = hostTestState()
    await attach()
    await turn('running')
    await stopTurn()
    await turn('interrupted')
    await host.flushAllStreamedEvents()
    await store.renewLeases([])
    const relaunchedStore = await openTestAgentSessionRecordStore(root)
    const relaunched = new StructuredAgentSessionHost({
      agents: NO_STRUCTURED_AGENTS,
      logger: createStructuredAgentSessionLogger(),
      store: relaunchedStore,
      adapter: adapter(),
      journalDatabase: openTestJournalHostDatabase(root),
      claimKeyId: 'key-1',
      mintSpawnToken: () => 'spawn-next',
      probeOwner: async () => ({ outcome: 'pid-absent' }),
      now: () => NOW + 1
    })
    replaceHostTestState({ store: relaunchedStore, host: relaunched })
    host = relaunched
    await startAgent({ host, store: relaunchedStore })
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await statusRows()).toEqual([REQUESTED])
  })
})

describe('a Stop of a turn that ended by itself', () => {
  it('writes no row', async () => {
    await attach()
    await turn('running')
    await turn('completed')
    cancelTurn.mockResolvedValueOnce({ cancelled: false })

    expect(await stopTurn()).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(await statusRows()).toEqual([])
  })
})
