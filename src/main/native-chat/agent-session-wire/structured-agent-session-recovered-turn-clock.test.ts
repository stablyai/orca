// A turn that was running when its host went away ends when recovery settles it. That settlement is
// the edge the user needs to see — their work stopped — so the session reads as newly done then,
// and nothing along the way may call it a success. Every hop is the real one: durable journal,
// recovery settlement, status feed, the host's status row, and the turn-completion feed.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionStatusSummary,
  AgentSessionTurnCompletionEvent
} from '../../../shared/agent-session-wire'
import { AgentHookServer, _internals } from '../../agent-hooks/server'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { settleStructuredAgentSessionDeadGeneration } from './structured-agent-session-dead-generation-settlement'
import {
  settleStaleSessionStateOnAcquire,
  type StructuredAgentSessionTurnVerdict
} from './structured-agent-session-stale-turn-verdict'
import { StructuredAgentSessionStatusFeed } from './structured-agent-session-status-feed'
import { indexedStatusFeedSession } from './structured-agent-session-status-feed-test-session'
import { StructuredAgentSessionTurnCompletionFeed } from './structured-agent-session-turn-completion-feed'

const SESSION = 'recovered-turn-session'
const THREAD = 'thread-1'
const TURN_STARTED = 1_000
const EXIT_OBSERVED = 2_000
const RECOVERED = 9_000

let root: string
const journals = createTrackedJournalOpener()

beforeEach(async () => {
  _internals.resetCachesForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-recovered-turn-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

/** A session whose turn was running when its host went away, reopened by the next host. */
async function sessionWithRunningTurn() {
  let clock = TURN_STARTED
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    now: () => clock,
    journalDir: join(root, SESSION)
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'prompt-1' },
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'long job' }] },
    { fence: 1 }
  )
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 9 },
    { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: TURN_STARTED },
    { fence: 1 }
  )
  const server = new AgentHookServer()
  const sessions = new Map([[SESSION, indexedStatusFeedSession({ journal })]])
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getRecord: () => null,
    now: () => clock,
    statusSink: () => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject)
    })
  })
  const summaries: AgentSessionStatusSummary[] = []
  feed.subscribe({
    id: 'list-1',
    emit: (event) => {
      if (event.type === 'snapshot') {
        summaries.push(...event.sessions)
      } else if (event.type === 'status') {
        summaries.push(event.session)
      }
    }
  })
  const completions = new StructuredAgentSessionTurnCompletionFeed({ sessions, now: () => clock })
  const completionEvents: AgentSessionTurnCompletionEvent[] = []
  completions.subscribe({ id: 'dot-1', emit: (event) => completionEvents.push(event) })
  // Both feeds have seen the turn running, so its settlement is a transition they must judge.
  completions.observe(SESSION, journal)
  expect(summaries.at(-1)).toMatchObject({ status: 'working', statusStartedAt: TURN_STARTED })
  const publish = (): void => {
    feed.publish(SESSION, journal)
    completions.observe(SESSION, journal)
  }
  return {
    journal,
    server,
    summaries,
    completionEvents,
    publish,
    recoverAt: (at: number) => {
      clock = at
    }
  }
}

function settleDeadGeneration(
  journal: AgentSessionJournal,
  verdict: StructuredAgentSessionTurnVerdict
): Promise<boolean> {
  return settleStructuredAgentSessionDeadGeneration({
    journal,
    sessionId: SESSION,
    fence: 2,
    settlementId: 'settle-1',
    verdict,
    pendingSubmissionReason: 'provider_exited_before_acknowledgement'
  })
}

describe('a turn recovery settled after its host went away', () => {
  it.each([
    ['an unverifiable end', { state: 'unverifiable' } as const],
    ['an exit observed before the restart', { state: 'interrupted', completedAt: EXIT_OBSERVED }]
  ] satisfies [string, StructuredAgentSessionTurnVerdict][])(
    'is done as of the recovery, never as a success: %s',
    async (_label, verdict) => {
      const session = await sessionWithRunningTurn()
      session.recoverAt(RECOVERED)
      expect(await settleDeadGeneration(session.journal, verdict)).toBe(true)
      session.publish()

      expect(session.summaries.at(-1)).toMatchObject({
        status: 'idle',
        statusStartedAt: RECOVERED
      })
      expect(session.summaries.at(-1)).not.toHaveProperty('turnOutcome')
      const [row] = session.server.getStatusSnapshot()
      // A done row dated at the recovery is a completion the user has not read yet.
      expect(row).toMatchObject({
        state: 'done',
        stateStartedAt: RECOVERED,
        mainAgent: { state: 'done', stateStartedAt: RECOVERED }
      })
      expect(row?.mainAgent).not.toHaveProperty('outcome')
      // The dot and the OS notification come only from a completion event, and none is sent.
      expect(session.completionEvents).toEqual([])
    }
  )

  it('is dated the same way when a new provider child finds the turn still running', async () => {
    const session = await sessionWithRunningTurn()
    session.recoverAt(RECOVERED)
    await settleStaleSessionStateOnAcquire({
      journal: session.journal,
      sessionId: SESSION,
      fence: 2,
      acquisitionGeneration: 'generation-2'
    })
    session.publish()

    expect(session.summaries.at(-1)).toMatchObject({
      status: 'idle',
      statusStartedAt: RECOVERED
    })
    expect(session.server.getStatusSnapshot()[0]).toMatchObject({
      state: 'done',
      stateStartedAt: RECOVERED
    })
    expect(session.completionEvents).toEqual([])
  })

  // The control that keeps the silence above from being vacuous: a turn its provider finished does
  // reach the completion feed through this same harness, dated by its own end.
  it('leaves a turn its provider finished to the provider, dated by its own end', async () => {
    const session = await sessionWithRunningTurn()
    session.recoverAt(RECOVERED)
    await session.journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 9 },
      {
        kind: 'turn',
        turnId: 'turn-1',
        state: 'completed',
        outcome: 'success',
        startedAt: TURN_STARTED,
        completedAt: EXIT_OBSERVED
      },
      { fence: 1 }
    )
    session.publish()

    expect(session.summaries.at(-1)).toMatchObject({
      status: 'idle',
      statusStartedAt: EXIT_OBSERVED,
      turnOutcome: 'success'
    })
    expect(session.completionEvents).toEqual([
      expect.objectContaining({
        type: 'completion',
        completion: expect.objectContaining({ outcome: 'success' })
      })
    ])
  })
})
