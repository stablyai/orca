import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalSubmission } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { createStructuredAgentSessionLogger } from '../../../host/structured-agent-session-logger'
import { createStructuredAgentSessionStatusReader } from '../../../observations/structured-agent-session-status-reader'
import { indexedStatusFeedSession } from '../../../observations/testing/structured-agent-session-status-feed-test-session.test-fixture'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

async function openChat(name: string, held: Set<string>) {
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, name)
  })
  const session = {
    ...indexedStatusFeedSession({ journal, provider: 'claude' }),
    child: { phase: 'ready' as const, generation: null, fence: 1, heldSends: () => held }
  }
  const reader = createStructuredAgentSessionStatusReader(
    {
      sessions: new Map([[SESSION, session]]),
      getConversation: () => null,
      now: () => 1_000,
      logger: createStructuredAgentSessionLogger()
    },
    () => {}
  )
  const subscribers = new AgentSessionSubscribers({
    readCurrentWork: reader.work,
    readWorkFrame: reader.workFrame
  })
  let pane: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  const events: AgentSessionSubscribeEvent[] = []
  const send = () => pane.submissions.find((entry) => entry.clientMessageId === 'send')
  const delivered = (from: number) =>
    events
      .slice(from)
      .flatMap((event): AgentJournalSubmission[] =>
        event.type === 'batch'
          ? event.batch.submissions
          : event.type === 'snapshot'
            ? event.page.submissions
            : []
      )
      .filter((entry) => entry.clientMessageId === 'send')
      .map((entry) => entry.dispatchState)
  const open = () =>
    subscribers.open({
      id: 'pane',
      sessionId: SESSION,
      journal,
      fence: 1,
      emit: (event) => {
        events.push(event)
        pane = reduceStructuredAgentSession(pane, { type: 'event', event })
      }
    })
  const submit = () =>
    journal.appendSubmission({
      clientMessageId: 'send',
      fence: 1,
      payloadFingerprint: 'send',
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued send' }] }
    })
  /** Runs `step` once, just before the `nth` page read from now. */
  const beforePageRead = (step: () => unknown, nth = 1) => {
    let reads = 0
    const real = journal.history.bind(journal)
    vi.spyOn(journal, 'history').mockImplementation(async (...args: Parameters<typeof real>) => {
      reads += 1
      if (reads === nth) {
        await step()
      }
      return real(...args)
    })
  }
  return { journal, subscribers, events, open, submit, send, delivered, beforePageRead }
}

it('a send accepted between the work answer and the page read publishes accepted', async () => {
  const chat = await openChat('race', new Set(['send']))
  chat.open()
  await vi.waitFor(() => expect(chat.events.some((event) => event.type === 'snapshot')).toBe(true))
  await chat.submit()
  const pendingSequence = chat.journal.cursor().sequence
  const before = chat.events.length

  // The pending commit's delivery answers work, then the accept commits before its page read.
  chat.beforePageRead(() =>
    chat.journal.resolveDispatch({
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'send-echo' }
    })
  )
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(chat.journal.cursor().sequence).toBeGreaterThan(pendingSequence))
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(chat.send()?.dispatchState).toBe('accepted'))

  expect(chat.delivered(before)).not.toContain('pending')
})

it('a page that reads a commit main has not adopted keeps the effective send state', async () => {
  const chat = await openChat('page-ahead', new Set())
  await chat.submit()
  chat.open()
  await vi.waitFor(() => expect(chat.send()?.dispatchState).toBe('unknown'))
  const before = chat.events.length

  // SQL readers see the next commit before main adopts its cursor.
  const adopted = { cursor: chat.journal.cursor(), physical: chat.journal.physicalCursor() }
  let lagging = true
  const cursor = chat.journal.cursor.bind(chat.journal)
  const physical = chat.journal.physicalCursor.bind(chat.journal)
  vi.spyOn(chat.journal, 'cursor').mockImplementation((): AgentJournalCursor =>
    lagging ? { ...adopted.cursor } : cursor()
  )
  vi.spyOn(chat.journal, 'physicalCursor').mockImplementation((): AgentJournalCursor =>
    lagging ? { ...adopted.physical } : physical()
  )
  await chat.journal.appendItem(
    { provider: 'orca', clientMessageId: 'unrelated' },
    { kind: 'status', text: 'unrelated' },
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  // Main adopts the commit only after the rebaseline has read the newer page once.
  chat.beforePageRead(() => {
    lagging = false
  }, 2)
  chat.subscribers.snapshot(SESSION, chat.journal, 1)
  await vi.waitFor(() => expect(chat.events.length).toBeGreaterThan(before))
  lagging = false
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() =>
    expect(chat.events.slice(before).some((event) => event.type === 'snapshot')).toBe(true)
  )

  expect(chat.delivered(before)).not.toContain('pending')
  expect(chat.send()?.dispatchState).toBe('unknown')
})
