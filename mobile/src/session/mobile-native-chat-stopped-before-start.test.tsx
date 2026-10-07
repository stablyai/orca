// The phone draws a send a Stop took back before the agent started it where it was sent, with the
// one row after it, and gives neither a turn of its own.

import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { DISPATCH_REJECTED_CANCELLED } from '../../../src/shared/structured-agent-session-dispatch-rejection'
import { projectStructuredAgentSessionMessages } from '../../../src/shared/structured-agent-session-message-projection'
import { selectStructuredAgentSettledTurns } from '../../../src/shared/structured-agent-session-turn-timing'

vi.mock('react-native', async () => {
  const React = await import('react')
  const Text = ({ children, ...props }: { children?: React.ReactNode }): React.ReactNode =>
    React.createElement('Text', props, children)
  return {
    ActivityIndicator: 'ActivityIndicator',
    Animated: {
      Text,
      Value: class {
        setValue(): void {}
      },
      loop: (animation: unknown) => animation,
      sequence: () => ({ start: vi.fn(), stop: vi.fn() }),
      timing: () => ({ start: vi.fn(), stop: vi.fn() })
    },
    Image: 'Image',
    Platform: { OS: 'ios' },
    Pressable: 'Pressable',
    Text,
    View: ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement('View', props, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }
  }
})
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }))
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronDown: 'ChevronDown',
  Copy: 'Copy',
  SquareChevronRight: 'SquareChevronRight',
  SquareTerminal: 'SquareTerminal',
  Wrench: 'Wrench',
  ChevronRight: 'ChevronRight'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: () => null }))
vi.mock('../components/MobileSelectableText', async () => {
  const React = await import('react')
  return {
    MobileSelectableText: ({ children }: { children?: React.ReactNode }) =>
      React.createElement('Text', null, children)
  }
})
vi.mock('./MobileNativeChatMessageActionsSheet', () => ({
  MobileNativeChatMessageActionsSheet: () => null
}))

import { MobileMarkdown } from '../components/MobileMarkdown'
import { MobileNativeChatMessage } from './MobileNativeChatMessage'
import { useMobileNativeChatTurnDisclosure } from './use-mobile-native-chat-turn-disclosure'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
}

const sent = (id: string, text: string) =>
  item(agentJournalSubmissionKey(id), {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })

function submission(
  clientMessageId: string,
  overrides: Partial<AgentJournalSubmission> = {}
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'accepted',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 2,
    ...overrides
  }
}

const items = [
  sent('warm-up', 'warm up'),
  item('t1', {
    kind: 'turn',
    turnId: 't1',
    state: 'completed',
    outcome: 'success',
    userItemId: agentJournalSubmissionKey('warm-up'),
    startedAt: 1_000,
    completedAt: 4_000
  }),
  item(
    't1-answer',
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Warmed up.' }] },
    { kind: 'turn', turnItemId: 't1' }
  ),
  sent('never-ran', 'look around')
]
const submissions = [
  submission('warm-up'),
  submission('never-ran', { dispatchState: 'rejected', reason: DISPATCH_REJECTED_CANCELLED })
]

type Disclosure = ReturnType<typeof useMobileNativeChatTurnDisclosure>
let disclosure: Disclosure | null = null

function Harness({ messages }: { messages: readonly NativeChatMessage[] }): null {
  disclosure = useMobileNativeChatTurnDisclosure({
    messages,
    enabled: true,
    isWorking: false,
    settledTurns: selectStructuredAgentSettledTurns(items, submissions),
    turnJournal: { items, submissions },
    workingStartedAt: null,
    scopeKey: 'host\0worktree\0tab-a'
  })
  return null
}

describe('a send a Stop took back before the agent started it, on the phone', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it('stays where it was sent, with the stop row after it and no turn status of its own', () => {
    const messages = projectStructuredAgentSessionMessages(items, [], submissions, {
      rejectedInPlace: false
    })
    expect(messages.map((message) => message.id)).toEqual([
      agentJournalSubmissionKey('warm-up'),
      't1-answer',
      agentJournalSubmissionKey('never-ran'),
      `stopped-before-start:${agentJournalSubmissionKey('never-ran')}`
    ])

    act(() => {
      renderer = create(createElement(Harness, { messages }))
    })
    const statuses = messages.map(
      (message, index) => disclosure?.resolveRow(index, message).turnStatus ?? null
    )
    expect(statuses[0]?.workedSeconds).toBe(3)
    expect(statuses.slice(2)).toEqual([null, null])

    act(() => renderer?.unmount())
    act(() => {
      renderer = create(createElement(MobileNativeChatMessage, { message: messages[3]! }))
    })
    expect(renderer!.root.findAllByType(MobileMarkdown).map((node) => node.props.content)).toEqual([
      'Stopped before the agent started'
    ])
  })
})
