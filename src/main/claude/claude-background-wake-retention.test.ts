// A finished child leaves the strip and the sidebar at once (both list running children only), and
// its record stays in the host's store until the user's next turn. Claude wakes the agent on its
// own when a background task ends, which opens a root turn nobody sent and retires nothing:
// replayed from captured frame orders through the real adapter, a real hook server and the
// production status feed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../shared/agent-session-journal-types'
import { structuredRunningChildWork } from '../../shared/agent-child-work-listing'
import type { AgentHookServer } from '../agent-hooks/server'
import type { StructuredAgentSessionJournalProjections } from '../native-chat/agent-session-wire/structured-agent-session-status-journal-projection'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import { backgroundWakeCapture } from './claude-captured-fold-steer-frames.test-fixture'
import { MOVED_TO_BACKGROUND } from './claude-captured-task-frames.test-fixture'
import { hostWithParent, parent, producer } from './claude-child-work-producer-harness.test-fixture'
import { PROVIDER_SESSION_ID } from './claude-structured-session-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

type Journal = Parameters<StructuredAgentSessionJournalProjections['read']>[0]

/** The production feed over what the adapter journaled, with the user's sends as `submissions`. */
async function wiredSession() {
  const host: AgentHookServer = hostWithParent()
  const run = await producer(host)
  const submissions: AgentJournalSubmission[] = []
  let sequence = 0
  const journal = {
    cursor: () => ({ epoch: 'epoch-1', sequence: ++sequence }),
    isReadOnly: false,
    lastActivityAt: () => 1,
    snapshot: () => ({
      items: [...run.journalItems.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => ({ ...item, revision: 1 })),
      submissions: submissions.map((submission) => ({ ...submission }))
    })
  }
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        parent.sessionId,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the feed reads only the cursor, read-only flag, activity clock and snapshot served here.
          journal: journal as unknown as Journal,
          params: {
            location: {
              executionHostId: parent.executionHostId,
              wslDistro: parent.wslDistro,
              workspaceId: parent.workspaceId,
              workspaceKind: parent.workspaceKind
            },
            provider: 'claude' as const
          }
        }
      ]
    ]),
    getRecord: () => null,
    now: () => Date.now(),
    statusSink: () => ({
      publish: (summary, subject) => host.ingestStructuredStatus(summary, subject),
      forget: (subject) => host.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        host.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => host.getStructuredChildWorkViews(subject)
    })
  })
  const describe = (views: ReturnType<typeof host.getStructuredChildWorkViews>) =>
    views.map((view) => `${view.description}:${view.membership}:${view.outcome ?? ''}`)
  /** The store's records for the session. */
  const records = () => describe(host.getStructuredChildWorkViews(parent))
  /** What the strip and the sidebar list. */
  const running = () =>
    describe(structuredRunningChildWork(host.getStructuredChildWorkViews(parent)))
  const replay = (frames: readonly CapturedFrame[]) => {
    for (const captured of frames) {
      run.replay([captured])
      feed.publish(parent.sessionId)
    }
  }
  /** The user writes a message now, on the host clock; the provider takes it once `accepted`. */
  const send = (clientMessageId: string): AgentJournalSubmission => {
    const submission: AgentJournalSubmission = {
      clientMessageId,
      fence: 7,
      payloadFingerprint: clientMessageId,
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: run.now(),
      resolvedAt: null
    }
    submissions.push(submission)
    feed.publish(parent.sessionId)
    return submission
  }
  const accept = (submission: AgentJournalSubmission) => {
    submission.dispatchState = 'accepted'
    feed.publish(parent.sessionId)
  }
  const rootTurns = () =>
    [...run.journalItems.values()].filter((item) => !item.agentId && item.body.kind === 'turn')
  return { run, feed, records, running, replay, send, accept, rootTurns }
}

describe("a finished child's record stays until the user's next turn", () => {
  it("keeps a background agent through Claude's own wake turn, then retires it at the next send", async () => {
    const session = await wiredSession()
    session.replay(MOVED_TO_BACKGROUND)
    // The agent settled at +52,441 and Claude woke the agent at +54,303: a second root turn.
    expect(session.rootTurns()).toHaveLength(2)
    expect(session.records()).toContain('Run 45s sleep command:settled:succeeded')
    // Nothing runs, so the strip and the sidebar list nothing.
    expect(session.running()).toEqual([])

    const next = session.send('next-send')
    // Written, not yet taken: nothing retires on a send the provider may still refuse.
    expect(session.records()).toContain('Run 45s sleep command:settled:succeeded')
    session.accept(next)
    expect(session.records()).toEqual([])
  })

  it('keeps a background shell through the wake its completion opens, and a steer into that wake retires it', async () => {
    const session = await wiredSession()
    const { firstTurn, wake } = backgroundWakeCapture({
      sessionId: PROVIDER_SESSION_ID,
      first: 'first-uuid',
      steer: 'steer-uuid'
    })
    session.accept(session.send('first-uuid'))
    session.replay(firstTurn)
    expect(session.running()).toEqual(['Sleep then print marker:live:'])

    const wakeInit = wake.findIndex((captured) => captured.frame.subtype === 'init')
    session.replay(wake.slice(0, wakeInit + 1))
    // The completion frame opened Claude's own wake turn; the finished shell is still listed.
    expect(session.rootTurns()).toHaveLength(2)
    expect(session.records()).toEqual(['Sleep then print marker:settled:succeeded'])
    expect(session.running()).toEqual([])

    // The user steers while the wake runs; Claude folds it into that turn and takes it.
    session.accept(session.send('steer-uuid'))
    expect(session.records()).toEqual([])
    session.replay(wake.slice(wakeInit + 1))
    expect(session.records()).toEqual([])
  })
})
