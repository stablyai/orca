import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/structured-agent-session-reducer'
import type { JournalObserverResult } from '../../../../agent-session-journal/journal-observer-read'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { StructuredAgentSessionObservedWork } from '../../../observations/structured-agent-session-observed-work'
import { readAgentSessionHistory } from '../../history/agent-session-history-page'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

function work(restatedSubmissions: AgentJournalSubmission[]): JournalObserverResult['work'] {
  const view = JSON.stringify(restatedSubmissions.map((send) => send.dispatchState))
  return {
    liveFence: 1,
    allowsObservation: true,
    working: restatedSubmissions.length > 0,
    commandAdmission: { promptPending: false, owesSend: false, handoverOwesSend: false },
    owesAnySend: false,
    owedEnteredSubmissions: [],
    owedSendingSubmissions: [],
    activeTurn: null,
    latestTurn: null,
    actionablePrompts: [],
    restatedSubmissions,
    viewKey: view,
    workViewKey: view
  }
}

function submissions(event: AgentSessionSubscribeEvent): AgentJournalSubmission[] {
  return event.type === 'batch' ? event.batch.submissions : []
}

it('a send accepted between the work answer and the page read publishes accepted', async () => {
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory: join(fixture.root, 'race')
  })
  let pending: AgentJournalSubmission | undefined
  let pendingSequence = -1
  let acceptBeforePageRead: (() => Promise<unknown>) | undefined
  const readHistory = journal.history.bind(journal)
  vi.spyOn(journal, 'history').mockImplementation(async (request) => {
    const accept = acceptBeforePageRead
    acceptBeforePageRead = undefined
    await accept?.()
    return readHistory(request)
  })
  const subscribers = new AgentSessionSubscribers({
    readCurrentWork: async (_sessionId, source) => {
      const cursor = source.cursor()
      const held = pending && cursor.sequence === pendingSequence ? [pending] : []
      return new StructuredAgentSessionObservedWork(source, work(held), cursor)
    }
  })
  let pane: StructuredAgentSessionState = EMPTY_STRUCTURED_AGENT_SESSION
  const events: AgentSessionSubscribeEvent[] = []
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
  await vi.waitFor(() => expect(events.some((event) => event.type === 'snapshot')).toBe(true))

  await journal.appendSubmission({
    clientMessageId: 'send',
    fence: 1,
    payloadFingerprint: 'send',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued send' }] }
  })
  pendingSequence = journal.cursor().sequence
  const history = await readAgentSessionHistory(journal, {
    sessionId: SESSION,
    direction: 'after',
    cursor: { epoch: journal.cursor().epoch, sequence: 0 },
    limit: 10
  })
  pending = history.page.submissions.find((send) => send.clientMessageId === 'send')
  expect(pending?.dispatchState).toBe('pending')
  const before = events.length

  acceptBeforePageRead = () =>
    journal.resolveDispatch({
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted',
      providerIdentity: { provider: 'claude', sessionId: 'native-1', uuid: 'send-echo' }
    })
  // The pending commit's delivery answers work, then the accept commits before its page read.
  subscribers.publish(SESSION, journal)
  await vi.waitFor(() => expect(journal.cursor().sequence).toBeGreaterThan(pendingSequence))
  subscribers.publish(SESSION, journal)
  await vi.waitFor(() =>
    expect(pane.submissions.find((send) => send.clientMessageId === 'send')?.dispatchState).toBe(
      'accepted'
    )
  )

  const published = events
    .slice(before)
    .flatMap(submissions)
    .filter((send) => send.clientMessageId === 'send')
  expect(published.map((send) => send.dispatchState)).toEqual(['accepted'])
})
