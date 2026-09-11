// INVARIANT — never evict mid-turn.
//
// A pending approval surviving a client-link drop is EMERGENT. Nothing keeps the prompt answerable
// on its own: the session outlives the drop only because the release clock re-arms while a turn is
// open instead of evicting (`structured-agent-session-release-clock.ts`). An eviction path that does
// not consult that check stops the provider child with the prompt unanswered — the user's approval
// is gone and no reader anywhere reports an error. So the invariant is pinned here by name.
//
// ACCEPTED LOSS: host shutdown already bypasses the check. Quitting tears the session down mid-turn
// and a pending approval goes with it. That is accepted, not fixed here.

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentJournalTurnLifecycleState } from '../../../shared/agent-session-journal-types'
import { agentJournalTurnBody } from '../../../shared/agent-session-turn-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState,
  seedApproval
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

/** The contract by name, so a failure here reads as the invariant that broke rather than as an
 *  unexplained refusal from a session that is simply gone. */
const NEVER_EVICT_MID_TURN =
  'INVARIANT never-evict-mid-turn: an open turn re-arms the release clock, and that is the only reason a pending approval survives a client-link drop'

const SURFACE = 'desktop-chat:1'
/** Short enough to keep the suite fast, long enough that an eviction is a decision and not a race. */
const GRACE_MS = 5

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let acquire: Mock<StructuredAgentSessionAdapter['acquire']>
let answerPrompt: Mock<StructuredAgentSessionAdapter['answerPrompt']>
let events: StructuredAgentSessionEventSink | undefined

beforeEach(() => {
  ;({ root, store, acquire, answerPrompt } = hostTestState())
  events = undefined
  const spawn = acquire.getMockImplementation()
  acquire.mockImplementation(async (input) => {
    events = input.events
    return spawn!(input)
  })
  // The harness host waits out the product grace window; this one answers within the test.
  host = new StructuredAgentSessionHost({
    store,
    adapter: adapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    releaseGraceMs: GRACE_MS,
    now: () => NOW
  })
  replaceHostTestState({ store, host })
})

/** The provider's own turn record, written through the sink it was handed. */
async function turnRecord(state: AgentJournalTurnLifecycleState): Promise<void> {
  const sink = events
  if (!sink) {
    throw new Error('the adapter was never handed an event sink')
  }
  sink.appendItem(
    {
      provider: 'legacy',
      agent: 'codex',
      sessionId: SESSION,
      recordId: 'turn-lifecycle:turn-1'
    },
    agentJournalTurnBody({ turnId: 'turn-1', state })
  )
  sink.publish()
  await host.flushStreamedEvents(SESSION)
}

/** Long enough for several grace windows to elapse, so "not evicted" means the clock declined. */
function waitOutSeveralGraceWindows(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GRACE_MS * 20))
}

describe(NEVER_EVICT_MID_TURN, () => {
  it('leaves a pending approval answerable after every client link has dropped', async () => {
    const prompt = await seedApproval()
    await attach()
    await host.hold(SESSION, SURFACE)
    await turnRecord('running')

    // The link drops: no surface is left holding the session.
    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()

    expect(host.hasSession(SESSION), NEVER_EVICT_MID_TURN).toBe(true)
    const fields = { itemId: prompt.itemId, expectedRevision: prompt.revision, optionId: 'allow' }
    const answer = await host.respondToPrompt(CALLER, {
      envelope: envelope('agentSession.respondTo:approval', fields),
      kind: 'approval',
      ...fields
    })
    expect(answer, NEVER_EVICT_MID_TURN).toMatchObject({
      ok: true,
      value: { resolution: { state: 'resolved', selectedOptionId: 'allow' } }
    })
    expect(answerPrompt).toHaveBeenCalledTimes(1)
  })

  it('holds the session on the turn and nothing else: the same drop evicts once the turn ends', async () => {
    await seedApproval()
    await attach()
    await host.hold(SESSION, SURFACE)
    await turnRecord('running')
    host.release(SESSION, SURFACE)
    await waitOutSeveralGraceWindows()
    expect(host.hasSession(SESSION)).toBe(true)

    await turnRecord('completed')

    // Emergent, not guaranteed: the pending prompt never blocked anything by itself.
    await vi.waitFor(() => expect(host.hasSession(SESSION)).toBe(false))
  })
})
