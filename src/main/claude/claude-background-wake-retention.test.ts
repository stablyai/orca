import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session/journal/agent-session-journal-types'
import { structuredRunningChildWork } from '../../shared/agent-status/child-work/agent-child-work-listing'
import type { AgentHookServer } from '../agent-hooks/server'
import { readTestJournalItems } from '../native-chat/agent-session-journal/journal-observation.test-support'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { StructuredAgentSessionStatusFeed } from '../native-chat/agent-session-wire/observations/structured-agent-session-status-feed'
import { indexedStatusFeedSession } from '../native-chat/agent-session-wire/observations/testing/structured-agent-session-status-feed-test-session.test-fixture'
import type { CapturedFrame } from './claude-captured-frame-builders.test-fixture'
import { backgroundWakeCapture } from './claude-captured-fold-steer-frames.test-fixture'
import { MOVED_TO_BACKGROUND } from './claude-captured-task-frames.test-fixture'
import { hostWithParent, parent, producer } from './claude-child-work-producer-harness.test-fixture'
import {
  identityFor,
  PROVIDER_SESSION_ID
} from './structured/claude-structured-session-test-support'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

const journals = createTrackedJournalOpener()
let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-wake-retention-'))
})

afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

async function wiredSession() {
  const host: AgentHookServer = hostWithParent()
  const journal = await journals.open({
    identity: identityFor(parent.sessionId),
    stateDirectory: root
  })
  const feed = new StructuredAgentSessionStatusFeed({
    logger: createStructuredAgentSessionLogger(),
    sessions: new Map([
      [
        parent.sessionId,
        {
          ...indexedStatusFeedSession({
            journal,
            child: { generation: 'spawn-9', fence: 7, phase: 'ready' },
            provider: 'claude'
          }),
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
    getConversation: () => null,
    now: () => Date.now(),
    statusSink: () => ({
      publish: (summary, subject) => host.ingestStructuredStatus(summary, subject),
      forget: (subject) => host.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) =>
        host.ingestStructuredChildWork(subject, evidence, provider),
      readChildWork: (subject) => host.getStructuredChildWorkViews(subject)
    })
  })
  const publish = () => feed.publish(parent.sessionId)
  const deferred = createDeferredStructuredAgentSessionEventSink(
    testEventSinkLogging(parent.sessionId)
  )
  deferred.bind({ journal, fence: 7, publish: () => void publish() })
  const run = await producer(host, deferred.sink)
  const describe = (views: ReturnType<typeof host.getStructuredChildWorkViews>) =>
    views.map((view) => `${view.description}:${view.membership}:${view.outcome ?? ''}`)
  const records = () => describe(host.getStructuredChildWorkViews(parent))
  const running = () =>
    describe(structuredRunningChildWork(host.getStructuredChildWorkViews(parent)))
  const replay = async (frames: readonly CapturedFrame[]) => {
    for (const captured of frames) {
      run.replay([captured])
      expect(await deferred.drained()).toEqual({ ok: true })
      await publish()
    }
  }
  const send = async (clientMessageId: string): Promise<string> => {
    await journal.appendSubmission({
      clientMessageId,
      payloadFingerprint: clientMessageId,
      fence: 7,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] }
    })
    await journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence: 7,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    })
    await publish()
    return clientMessageId
  }
  const accept = async (clientMessageId: string) => {
    await journal.resolveDispatch({
      clientMessageId,
      state: 'accepted',
      fence: 7,
      providerIdentity: null
    })
    await publish()
  }
  const rootTurns = async () =>
    (await readTestJournalItems(journal)).filter(
      (item) => !item.agentId && item.body.kind === 'turn'
    )
  return { run, feed, records, running, replay, send, accept, rootTurns }
}

describe("a finished child's record stays until the user's next turn", () => {
  it("keeps a background agent through Claude's own wake turn, then retires it at the next send", async () => {
    const session = await wiredSession()
    await session.replay(MOVED_TO_BACKGROUND)
    expect(await session.rootTurns()).toHaveLength(2)
    expect(session.records()).toContain('Run 45s sleep command:settled:succeeded')
    expect(session.running()).toEqual([])

    const next = await session.send('next-send')
    // Submitting is not acceptance; a refused send must not retire retained work.
    expect(session.records()).toContain('Run 45s sleep command:settled:succeeded')
    await session.accept(next)
    expect(session.records()).toEqual([])
  })

  it('keeps a background shell through the wake its completion opens, and a steer into that wake retires it', async () => {
    const session = await wiredSession()
    const { firstTurn, wake } = backgroundWakeCapture({
      sessionId: PROVIDER_SESSION_ID,
      first: 'first-uuid',
      steer: 'steer-uuid'
    })
    await session.accept(await session.send('first-uuid'))
    await session.replay(firstTurn)
    expect(session.running()).toEqual(['Sleep then print marker:live:'])

    const wakeInit = wake.findIndex((captured) => captured.frame.subtype === 'init')
    await session.replay(wake.slice(0, wakeInit + 1))
    expect(await session.rootTurns()).toHaveLength(2)
    expect(session.records()).toEqual(['Sleep then print marker:settled:succeeded'])
    expect(session.running()).toEqual([])

    await session.accept(await session.send('steer-uuid'))
    expect(session.records()).toEqual([])
    await session.replay(wake.slice(wakeInit + 1))
    expect(session.records()).toEqual([])
  })
})
