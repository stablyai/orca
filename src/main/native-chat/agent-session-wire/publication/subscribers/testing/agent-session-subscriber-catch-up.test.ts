import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../../../../shared/agent-session/journal/agent-session-journal-identity'

import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import type { AgentSessionJournal } from '../../../../agent-session-journal/journal-store'
import { openTestAgentSessionDatabase } from '../../../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { createStructuredAgentSessionLogger } from '../../../host/structured-agent-session-logger'

import { createStructuredAgentSessionStatusReader } from '../../../observations/structured-agent-session-status-reader'
import { indexedStatusFeedSession } from '../../../observations/testing/structured-agent-session-status-feed-test-session.test-fixture'
import { AgentSessionSubscribers } from '../structured-agent-session-subscribers'
import {
  structuredQueueSendGate,
  tryReadQueuePublication
} from '../../../delivery/structured-agent-session-queued-publication'
import { queuedImageReaderEvent } from '../../history/agent-session-queued-image-reader'
import {
  fixture,
  journals,
  SESSION
} from './structured-agent-session-subscriber-contract.test-fixture'

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function openChat(name: string, held: Set<string>) {
  const stateDirectory = join(fixture.root, name)
  const journal: AgentSessionJournal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-1', null)
    },
    stateDirectory
  })
  const database = await openTestAgentSessionDatabase(stateDirectory)
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
    readWorkFrame: reader.workFrame,
    // The production queue gate, over the same live owners the status reader sees.
    readQueuePublication: (sessionId, work, inLane) =>
      tryReadQueuePublication(
        journal,
        structuredQueueSendGate(
          {
            store: {
              getConversation: () => null,
              replacedRuntime: () => undefined,
              getRecord: () => null
            },
            sessions: new Map([[SESSION, session]])
          },
          sessionId,
          () => 1_000,
          work
        ),
        inLane
      )
  })
  const historyReads = vi.spyOn(journal, 'history')
  const ends = vi.fn<(cause: unknown) => void>()
  const queueReads = vi.spyOn(journal.reads, 'queue')
  /** Checked against the pane after every delivered event. */
  const invariants: (() => void)[] = []
  /** Runs after every lane operation already admitted, including a queued capture. */
  const laneDrained = () => journal.readInOrder(() => undefined)
  const panes = new Map<string, StructuredAgentSessionState>()
  const events: AgentSessionSubscribeEvent[] = []
  const eventsOf = new Map<string, AgentSessionSubscribeEvent[]>()
  const open = (id = 'pane', cursor?: AgentJournalCursor) =>
    subscribers.open({
      id,
      sessionId: SESSION,
      journal,
      fence: 1,
      ...(cursor ? { cursor } : {}),
      projectJournalEvent: queuedImageReaderEvent,
      end: ends,
      emit: (event) => {
        events.push(event)
        eventsOf.set(id, [...(eventsOf.get(id) ?? []), event])
        panes.set(
          id,
          reduceStructuredAgentSession(panes.get(id) ?? EMPTY_STRUCTURED_AGENT_SESSION, {
            type: 'event',
            event
          })
        )
        for (const invariant of invariants) {
          invariant()
        }
      }
    })
  const pane = (id = 'pane') => panes.get(id) ?? EMPTY_STRUCTURED_AGENT_SESSION
  /** A resuming client keeps the state it had at its cursor. */
  const resume = (id: string, from: StructuredAgentSessionState, cursor: AgentJournalCursor) => {
    panes.set(id, from)
    return open(id, cursor)
  }
  const sendState = (id: string, paneId?: string) =>
    pane(paneId).submissions.find((entry) => entry.clientMessageId === id)?.dispatchState
  const delivered = (from: number, id = 'send') =>
    events
      .slice(from)
      .flatMap((event): AgentJournalSubmission[] =>
        event.type === 'batch'
          ? event.batch.submissions
          : event.type === 'snapshot'
            ? event.page.submissions
            : []
      )
      .filter((entry) => entry.clientMessageId === id)
      .map((entry) => entry.dispatchState)
  const submit = (id = 'send') =>
    journal.appendSubmission({
      clientMessageId: id,
      fence: 1,
      payloadFingerprint: id,
      body: message('queued send')
    })
  /** The next write commits in SQL, then main adopts it only on `adopt()`. */
  const holdNextAdoption = () => {
    const committed = Promise.withResolvers<void>()
    const adoption = Promise.withResolvers<void>()
    const serialize = database.serialize.bind(database)
    type Writer = Parameters<Parameters<typeof serialize>[1]>[0]
    const spy = vi
      .spyOn(database, 'serialize')
      .mockImplementation(<T>(sessionId: string, run: (writer: Writer) => T | Promise<T>) =>
        serialize(sessionId, (writer) =>
          run({
            write: async (...args: Parameters<Writer['write']>) => {
              const commit = await writer.write(...args)
              spy.mockRestore()
              committed.resolve()
              await adoption.promise
              return commit
            },
            effects: (...args: Parameters<Writer['effects']>) => writer.effects(...args),
            maintain: (...args: Parameters<Writer['maintain']>) => writer.maintain(...args)
          })
        )
      )
    return { committed: committed.promise, adopt: () => adoption.resolve() }
  }
  return {
    journal,
    subscribers,
    events,
    eventsOf,
    historyReads,
    ends,
    queueReads,
    invariants,
    laneDrained,
    open,
    resume,
    pane,
    sendState,
    delivered,
    submit,
    holdNextAdoption
  }
}

it('a first snapshot abandoned mid-read is still sent before any other frame', async () => {
  const held = new Set(['send'])
  const chat = await openChat('owed-snapshot', held)
  await chat.submit()
  // The opening snapshot's authority changes during its read, so that capture is abandoned.
  chat.historyReads.mockImplementationOnce(async (...args) => {
    const read = chat.journal.history(...args)
    held.clear()
    return read
  })
  chat.open()
  await chat.laneDrained()
  chat.subscribers.publish(SESSION, chat.journal)
  await vi.waitFor(() => expect(chat.events.length).toBeGreaterThan(0))

  expect(chat.events[0]).toMatchObject({ type: 'snapshot', sessionId: SESSION, fence: 1 })
  expect(chat.sendState('send')).toBe('unknown')
})
