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

async function wiredSession() {
  const host: AgentHookServer = hostWithParent()
  const run = await producer(host)
  const submissions: AgentJournalSubmission[] = []
  let sequence = 0
  const journal = {
    cursor: () => ({ epoch: 'epoch-1', sequence: ++sequence }),
    lastActivityAt: () => 1,
    submissions: (): ReturnType<Journal['submissions']> =>
      submissions.map((submission) => ({ ...submission })),
    item: (itemId: string): ReturnType<Journal['item']> => {
      const item = run.journalItems.get(itemId)
      return item ? { ...item, revision: 1, observedAt: run.now() } : null
    },
    stopMarks: { latest: () => null, revision: () => 0 },
    itemFence: () => undefined,
    wroteBeforeOpen: () => false,
    runningTurn: () => null,
    snapshot: () => ({
      items: [...run.journalItems.values()]
        .sort((a, b) => a.sequence - b.sequence)
        .map((item) => ({ ...item, revision: 1, observedAt: run.now() })),
      submissions: submissions.map((submission) => ({ ...submission }))
    })
  }
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        parent.sessionId,
        {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the feed's cursor, clock, Stop marks, snapshot, submissions, item and provenance reads.
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
  const records = () => describe(host.getStructuredChildWorkViews(parent))
  const running = () =>
    describe(structuredRunningChildWork(host.getStructuredChildWorkViews(parent)))
  const replay = (frames: readonly CapturedFrame[]) => {
    for (const captured of frames) {
      run.replay([captured])
      feed.publish(parent.sessionId)
    }
  }
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
    expect(session.rootTurns()).toHaveLength(2)
    expect(session.records()).toContain('Run 45s sleep command:settled:succeeded')
    expect(session.running()).toEqual([])

    const next = session.send('next-send')
    // Submitting is not acceptance; a refused send must not retire retained work.
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
    expect(session.rootTurns()).toHaveLength(2)
    expect(session.records()).toEqual(['Sleep then print marker:settled:succeeded'])
    expect(session.running()).toEqual([])

    session.accept(session.send('steer-uuid'))
    expect(session.records()).toEqual([])
    session.replay(wake.slice(wakeInit + 1))
    expect(session.records()).toEqual([])
  })
})
