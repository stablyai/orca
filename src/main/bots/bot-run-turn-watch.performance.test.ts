import { afterEach, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { AgentSessionSubscribers } from '../native-chat/agent-session-wire/publication/subscribers/structured-agent-session-subscribers'
import { watchBotTurnEnds } from './bot-run-turn-watch'
import { StructuredAgentSessionConversations } from '../native-chat/agent-session-wire/host/structured-agent-session-conversations'
import type { JournalWriterCommit } from '../native-chat/agent-session-journal/journal-writer-changes'
import { hostTestAttachParams } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'

afterEach(() => vi.useRealTimers())

it.each([100, 1000])('keeps receipt-only commits quiet across %i bot watches', async (count) => {
  vi.useFakeTimers()
  const subscribers = new AgentSessionSubscribers()
  const work = { frames: 0, catchUps: 0, forwardReads: 0, tailReads: 0, operationReads: 0 }
  const conversations = new StructuredAgentSessionConversations({
    deliver: (id, journal) => {
      work.catchUps++
      subscribers.deliverFrames(id, journal)
    },
    logger: { warn: () => {}, error: () => {} },
    now: Date.now
  })
  const journals = Array.from({ length: count }, (_, index) => {
    const sessionId = `chat-${index}`
    let sequence = 1
    const cursor = () => ({ epoch: 'epoch', sequence })
    const submission: AgentJournalSubmission = {
      clientMessageId: 'run',
      fence: 1,
      payloadFingerprint: 'fingerprint',
      dispatchState: 'pending',
      providerItemId: null,
      reason: null,
      submittedAt: 1000,
      resolvedAt: null
    }
    const items: AgentJournalRenderItem[] = []
    const history = async () => {
      work.forwardReads++
      return {
        result: {
          ok: true,
          page: {
            sessionId,
            items,
            submissions: [submission],
            removedItemIds: [],
            window: { nextCursor: cursor() },
            hasNewer: false
          }
        }
      }
    }
    let committed: ((commit: JournalWriterCommit) => void) | undefined
    const journal = {
      cursor,
      history,
      readInOrder: async (read: () => unknown) => read(),
      observeCommits: (listener: (commit: JournalWriterCommit) => void) => {
        committed = listener
        return () => {
          committed = undefined
        }
      },
      epochReplacements: { observe: () => () => {} },
      stopMarks: { observeSettleEdges: () => () => {} }
    }
    conversations.set(sessionId, {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this seam supplies the journal's commit and history ports.
      journal: journal as never,
      params: hostTestAttachParams(null),
      child: null
    })
    let completionListeners = 0
    const host = {
      subscribeTurnCompletions: () => {
        completionListeners++
        return () => completionListeners--
      },
      subscribe: async (input: Parameters<AgentSessionSubscribers['open']>[0]) =>
        subscribers.open({
          ...input,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the journal methods used by subscriber opening and catch-up.
          journal: journal as never,
          fence: 1,
          emit: (event) => {
            if (event.type === 'batch' || event.type === 'reset') {
              work.frames++
            }
            input.emit(event)
          }
        }),
      history: async () => {
        work.tailReads++
        return { ok: false }
      },
      currentWork: async () => null,
      journalReads: async () => ({
        operationWindow: async () => {
          work.operationReads++
          return { snapshot: { items, submissions: [submission] } }
        }
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seam implements all reads and subscriptions used by the real watch.
    const end = watchBotTurnEnds(host as never).next({
      sessionId,
      clientMessageId: 'run',
      fingerprint: 'fingerprint'
    })
    const publish = (writtenOnly: boolean) => {
      if (!writtenOnly) {
        sequence++
      }
      const commit: JournalWriterCommit = {
        cursor: cursor(),
        inputChanged: !writtenOnly,
        keys: [],
        inputKeys: [],
        items: [],
        effects: [],
        value: undefined,
        ...(writtenOnly
          ? {
              publication: {
                writtenOnly: true,
                items: [],
                receipts: [],
                cards: []
              }
            }
          : {})
      }
      committed?.(commit)
    }
    return {
      sessionId,
      end,
      completionListeners: () => completionListeners,
      receipt: () => {
        publish(true)
      },
      complete: () => {
        items.push({
          itemId: 'turn',
          sequence: sequence + 1,
          revision: 0,
          observedAt: 3000,
          body: {
            kind: 'turn',
            turnId: 'turn',
            state: 'completed',
            outcome: 'success',
            userItemId: 'orca:run'
          }
        })
        publish(false)
      }
    }
  })
  const ends = Promise.all(journals.map((chat) => chat.end))
  await vi.advanceTimersByTimeAsync(300)
  expect(journals.every((chat) => subscribers.subscriberCount(chat.sessionId) === 1)).toBe(true)
  expect(work.operationReads).toBeGreaterThan(0)
  const before = { ...work }
  for (const chat of journals) {
    chat.receipt()
  }
  await vi.advanceTimersByTimeAsync(0)
  const receiptTimers = vi.getTimerCount()
  await vi.advanceTimersByTimeAsync(300)
  const receiptWork = {
    timers: receiptTimers,
    frames: work.frames - before.frames,
    catchUps: work.catchUps - before.catchUps,
    forwardReads: work.forwardReads - before.forwardReads,
    tailReads: work.tailReads - before.tailReads,
    operationReads: work.operationReads - before.operationReads
  }
  for (const chat of journals) {
    chat.complete()
  }
  await vi.advanceTimersByTimeAsync(300)
  expect(await ends).toEqual(
    Array.from({ length: count }, () => ({ outcome: 'success', message: '' }))
  )
  expect(journals.every((chat) => subscribers.subscriberCount(chat.sessionId) === 0)).toBe(true)
  expect(journals.every((chat) => chat.completionListeners() === 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
  expect(receiptWork).toEqual({
    timers: 0,
    frames: 0,
    catchUps: 0,
    forwardReads: 0,
    tailReads: 0,
    operationReads: 0
  })
})
