// Build the real mobile list to keep sends waiting behind opening turns after the owning live status; host rows replace accepted local echoes.

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
import { nativeChatTurnMembership } from '../../../src/shared/native-chat-turn-membership'
import {
  projectStructuredAgentSessionMessages,
  type StructuredAgentSessionOptimisticMessage
} from '../../../src/shared/structured-agent-session-message-projection'
import {
  buildMobileNativeChatTransientData,
  foldMobileNativeChatMessages
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

const openingItems = [userMessage('first', 5)]
const openingSubmissions = [submission('first', { acceptedSequence: 3, handedOverAt: NOW })]

const FIRST_TURN_PROVIDER_KEY = 'codex:thread:turn-first:0'
const firstTurnOpened = item('turn-first', 6, {
  kind: 'turn',
  turnId: 'turn-first',
  state: 'running',
  userItemId: FIRST_TURN_PROVIDER_KEY,
  startedAt: NOW
})

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>

function echo(
  clientMessageId: string,
  sentWhileStopping = false
): StructuredAgentSessionOptimisticMessage {
  return {
    clientMessageId,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: clientMessageId }] },
    queuedAt: NOW,
    ...(sentWhileStopping ? { sentWhileStopping: true as const } : {})
  }
}

function Harness(props: {
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  stopping: boolean
  optimistic: StructuredAgentSessionOptimisticMessage[]
  seen: (disclosure: Disclosure) => void
}): null {
  const messages: NativeChatMessage[] = projectStructuredAgentSessionMessages(
    props.items,
    props.optimistic,
    props.submissions
  )
  const { data } = buildMobileNativeChatTransientData({
    messages,
    folded: foldMobileNativeChatMessages(messages, 'claude'),
    streaming: null,
    pending: []
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
    optimistic: StructuredAgentSessionOptimisticMessage[] = []
  ): { listed: string[]; waiting: string[]; liveOn: string | undefined } {
    let seen: Disclosure | undefined
    act(() => {
      const element = createElement(Harness, {
        items,
        submissions,
        stopping,
        optimistic,
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

  it('keeps its own echo of an accepted send waiting after the live status, Stopping or not', () => {
    for (const stopping of [false, true]) {
      expect(frame(openingItems, openingSubmissions, stopping, [echo('second', stopping)])).toEqual(
        {
          listed: [agentJournalSubmissionKey('first')],
          waiting: [agentJournalSubmissionKey('second')],
          liveOn: agentJournalSubmissionKey('first')
        }
      )
    }
    expect(
      frame(
        [...openingItems, userMessage('b', 4)],
        [...openingSubmissions, submission('b', { acceptedSequence: 4 })],
        true,
        [echo('second', true)]
      ).waiting
    ).toEqual([agentJournalSubmissionKey('b'), agentJournalSubmissionKey('second')])
  })

  // Stop-withdrawn B remains at its send position without a waiting turn.
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
  // Opening-turn sends stay put as steers; Stopping sends wait behind the turn being stopped.
  it('draws its echo after a running turn, and waits behind it only when sent while Stopping', () => {
    const [first] = openingSubmissions
    if (!first) {
      throw new Error('expected the first send')
    }
    const running = [...openingItems, firstTurnOpened]
    const after = {
      listed: [agentJournalSubmissionKey('first'), agentJournalSubmissionKey('second')],
      waiting: [],
      liveOn: agentJournalSubmissionKey('first')
    }
    expect(frame(running, [echoed(first)], false, [echo('second')])).toEqual(after)
    expect(frame(running, [echoed(first)], true, [echo('second')])).toEqual(after)
    expect(frame(running, [echoed(first)], true, [echo('second', true)])).toEqual({
      listed: [agentJournalSubmissionKey('first')],
      waiting: [agentJournalSubmissionKey('second')],
      liveOn: agentJournalSubmissionKey('first')
    })
  })

  it('opens a turn of its own with its echo once the turn ahead has ended', () => {
    const [first] = openingSubmissions
    if (!first) {
      throw new Error('expected the first send')
    }
    const ended = [
      ...openingItems,
      item('turn-first', 6, {
        kind: 'turn',
        turnId: 'turn-first',
        state: 'completed',
        userItemId: FIRST_TURN_PROVIDER_KEY,
        startedAt: NOW
      })
    ]
    const messages = projectStructuredAgentSessionMessages(ended, [echo('second')], [echoed(first)])
    const { turnKeys } = nativeChatTurnMembership(messages, {
      items: ended,
      submissions: [echoed(first)]
    })
    expect(messages.map((message) => message.id)).toEqual([
      agentJournalSubmissionKey('first'),
      agentJournalSubmissionKey('second')
    ])
    expect(turnKeys[1]).toBe(agentJournalSubmissionKey('second'))
    expect(turnKeys[0]).not.toBe(turnKeys[1])
  })

  const steered = [
    ...openingItems,
    firstTurnOpened,
    { ...userMessage('second', 8), turnScope: { kind: 'turn' as const, turnItemId: 'turn-first' } }
  ]

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
      [
        [...openingItems, firstTurnOpened, userMessage('second', 7)],
        [first, submission('second', { acceptedSequence: 7 })]
      ],
      [steered, [first, handedOver]],
      [steered, [first, echoed(handedOver)]],
      [steered, [echoed(first), echoed(handedOver)]]
    ])
  })

  // Second is accepted before first’s handover, but handed over only after first’s turn record; projection must keep it behind first.
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
      [queuedAbove, [echoed(first), queued]],
      [steered, [first, handedOver]],
      [steered, [first, echoed(handedOver)]],
      [steered, [echoed(first), echoed(handedOver)]]
    ])
  })
})
