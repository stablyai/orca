// On the phone, as on the desktop: a message sent while the turn ahead is still opening waits after
// that turn's live status, and the live status stays on the turn ahead, never on the waiting one.
// The phone keeps no outbox: its rows are the host's recorded ones, plus its own echo of a send the
// host accepted, until that send's row arrives. The list is built as the phone's view builds it.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages,
  type MobileNativeChatPendingItem
} from './mobile-native-chat-render-data'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const NOW = 100_000

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody
): AgentJournalRenderItem {
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    turnScope: { kind: 'thread' }
  }
}

const userMessage = (id: string, sequence: number) =>
  item(agentJournalSubmissionKey(id), sequence, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: id }]
  })

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: NOW,
    resolvedAt: null,
    handoverRecorded: true,
    ...overrides
  }
}

/** "first" handed over (row 5) with no turn record yet: its turn opens. */
const openingItems = [userMessage('first', 5)]
const openingSubmissions = [submission('first', { acceptedSequence: 3, handedOverAt: NOW })]

/** The first send's turn record, written as its turn opens; Codex names its own provider key. */
const FIRST_TURN_PROVIDER_KEY = 'codex:thread:turn-first:0'
const firstTurnOpened = item('turn-first', 6, {
  kind: 'turn',
  turnId: 'turn-first',
  state: 'running',
  userItemId: FIRST_TURN_PROVIDER_KEY,
  startedAt: NOW
})

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>

function Harness(props: {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  stopping: boolean
  pending: MobileNativeChatPendingItem[]
  seen: (disclosure: Disclosure) => void
}): null {
  // As the phone projects: a recorded, rejected send drawn in place as not sent.
  const messages: NativeChatMessage[] = projectStructuredAgentSessionMessages(
    props.items,
    [],
    props.submissions,
    { rejectedInPlace: true }
  )
  const { data } = buildMobileNativeChatTransientData({
    messages,
    folded: foldMobileNativeChatMessages(messages),
    streaming: null,
    pending: props.pending
  })
  const disclosure = useMobileNativeChatTurnDisclosure({
    messages: data,
    enabled: true,
    isWorking: true,
    workingStartedAt: NOW,
    turnJournal: { items: props.items, submissions: props.submissions },
    stopping: props.stopping,
    scopeKey: 'host\0worktree\0tab-a'
  })
  props.seen(disclosure)
  return null
}

describe('a message sent while the turn ahead is still opening, on the phone', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function frame(
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[],
    stopping = false,
    pending: MobileNativeChatPendingItem[] = []
  ): { listed: string[]; waiting: string[]; liveOn: string | undefined } {
    let seen: Disclosure | undefined
    act(() => {
      const element = createElement(Harness, {
        items,
        submissions,
        stopping,
        pending,
        seen: (disclosure) => {
          seen = disclosure
        }
      })
      if (renderer) {
        renderer.update(element)
      } else {
        renderer = create(element)
      }
    })
    if (!seen) {
      throw new Error('expected the hook to render')
    }
    const disclosure = seen
    const listed = disclosure.listMessages.map((message) => message.id)
    const liveRow = disclosure.listMessages.findIndex(
      (message, index) => disclosure.resolveRow(index, message).turnStatus !== null
    )
    return {
      listed,
      waiting: disclosure.waitingRows.map(({ item: row }) => row.id),
      liveOn: liveRow === -1 ? undefined : listed[liveRow]
    }
  }

  // Accepted at a row above the first send's handover, yet still drawn after its live status.
  it('keeps a queued send waiting after the live status', () => {
    expect(
      frame(
        [...openingItems, userMessage('second', 4)],
        [...openingSubmissions, submission('second', { acceptedSequence: 4 })]
      )
    ).toEqual({
      listed: [agentJournalSubmissionKey('first')],
      waiting: [agentJournalSubmissionKey('second')],
      liveOn: agentJournalSubmissionKey('first')
    })
  })

  // Its echo of a send the host accepted, before that send's row reaches the phone.
  it('keeps its own echo of an accepted send waiting after the live status, Stopping or not', () => {
    const echo = {
      id: 'pending-1',
      text: 'second',
      baselineTailMessageId: agentJournalSubmissionKey('first')
    }
    for (const stopping of [false, true]) {
      expect(frame(openingItems, openingSubmissions, stopping, [echo])).toEqual({
        listed: [agentJournalSubmissionKey('first')],
        waiting: ['pending-1'],
        liveOn: agentJournalSubmissionKey('first')
      })
    }
    // While Stopping, sent after a queued B the Stop holds.
    expect(
      frame(
        [...openingItems, userMessage('b', 4)],
        [...openingSubmissions, submission('b', { acceptedSequence: 4 })],
        true,
        [{ ...echo, baselineTailMessageId: agentJournalSubmissionKey('b') }]
      ).waiting
    ).toEqual([agentJournalSubmissionKey('b'), 'pending-1'])
  })

  // Taken back, B stays where it was sent with its stop row: listed after the live turn, no longer
  // waiting.
  it('lists B after the live turn when a Stop takes it back, never above the live status', () => {
    const queued = [...openingItems, userMessage('b', 4)]
    const stopping = frame(
      queued,
      [...openingSubmissions, submission('b', { acceptedSequence: 4 })],
      true
    )
    expect(stopping.waiting).toEqual([agentJournalSubmissionKey('b')])
    expect(stopping.listed).toEqual([agentJournalSubmissionKey('first')])

    const withdrawn = submission('b', {
      acceptedSequence: 4,
      dispatchState: 'rejected',
      resolvedAt: NOW + 200,
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
    })
    expect(frame(queued, [...openingSubmissions, withdrawn], true)).toEqual({
      listed: [
        agentJournalSubmissionKey('first'),
        agentJournalSubmissionKey('b'),
        `stopped-before-start:${agentJournalSubmissionKey('b')}`
      ],
      waiting: [],
      liveOn: agentJournalSubmissionKey('first')
    })
  })

  const echoed = (sent: AgentJournalSubmission): AgentJournalSubmission => ({
    ...sent,
    dispatchState: 'accepted',
    providerItemId: FIRST_TURN_PROVIDER_KEY,
    resolvedAt: NOW + 20
  })
  // Handed over as a steer once the turn opened (row 8).
  const steered = [
    ...openingItems,
    firstTurnOpened,
    { ...userMessage('second', 8), turnScope: { kind: 'turn' as const, turnItemId: 'turn-first' } }
  ]

  /** One frame per commit: "second" is listed in the turn it lands in, after "first", and the live
   *  status stays on "first". */
  function walkTurnOpening(steps: [AgentJournalRenderItem[], AgentJournalSubmission[]][]): void {
    for (const step of steps) {
      expect(frame(...step)).toEqual({
        listed: [agentJournalSubmissionKey('first'), agentJournalSubmissionKey('second')],
        waiting: [],
        liveOn: agentJournalSubmissionKey('first')
      })
    }
  }

  it('lists it in the turn ahead at every step of the turn opening, even with the steer echoed first', () => {
    const [first] = openingSubmissions
    if (!first) {
      throw new Error('expected the first send')
    }
    const handedOver = submission('second', { acceptedSequence: 7, handedOverAt: NOW + 10 })
    walkTurnOpening([
      // Recorded after the turn record, not yet handed over.
      [
        [...openingItems, firstTurnOpened, userMessage('second', 7)],
        [first, submission('second', { acceptedSequence: 7 })]
      ],
      [steered, [first, handedOver]],
      // Codex echoes the steer before the send that opened the turn, then that send.
      [steered, [first, echoed(handedOver)]],
      [steered, [echoed(first), echoed(handedOver)]]
    ])
  })

  // Two messages queued behind /compact, or sent while Stopping: "second" is accepted above the
  // first send's handover, and the first send's turn record lands before "second" is handed over.
  it('lists it in the turn ahead at every step when it was accepted above the first send', () => {
    const [first] = openingSubmissions
    if (!first) {
      throw new Error('expected the first send')
    }
    const queuedAbove = [userMessage('second', 4), ...openingItems, firstTurnOpened]
    const queued = submission('second', { acceptedSequence: 4 })
    const handedOver = { ...queued, handedOverAt: NOW + 10 }
    walkTurnOpening([
      [queuedAbove, [first, queued]],
      // The first send echoes while "second" is still queued.
      [queuedAbove, [echoed(first), queued]],
      [steered, [first, handedOver]],
      [steered, [first, echoed(handedOver)]],
      [steered, [echoed(first), echoed(handedOver)]]
    ])
  })
})
