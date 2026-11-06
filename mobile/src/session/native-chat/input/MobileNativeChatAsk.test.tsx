import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type {
  NativeChatAnswerSource,
  AskAnswerSelection
} from '../../../../../src/shared/native-chat/input/native-chat-ask-answer'
import type { AgentJournalRenderItem } from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import type { AskPrompt } from '../../../../../src/shared/native-chat/input/native-chat-ask-types'
import { NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS } from '../../../../../src/shared/native-chat/input/native-chat-question-auto-advance'
import '../../../../../src/shared/agent-session/agent-session-question-answer'
import { useMobileStructuredAgentSession } from '../../use-mobile-structured-agent-session'
import { useMobileStructuredAsyncQuestion } from '../../use-mobile-structured-async-question'
import {
  aggregateAsyncQuestions,
  scanPendingAsks
} from '../../../../../src/shared/native-chat/input/native-chat-ask'
import type { RpcClient } from '../../../transport/rpc-client'
import {
  acceptedSubmission,
  fieldsOf,
  ok,
  snapshotEvent
} from '../../use-mobile-structured-agent-session-queued.test-fixture'
import { MobileNativeChatAsk } from './MobileNativeChatAsk'
import './MobileNativeChatStructuredAsk'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
}))

vi.mock('react-native', () => ({
  Keyboard: { dismiss: () => {} },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  Linking: { openURL: () => Promise.resolve() },
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios }
}))
vi.mock('lucide-react-native', () => ({ Check: 'Check', ChevronDown: 'ChevronDown', X: 'X' }))
// The question renders through chat markdown; its diagram and copy-button leaves load native modules.
vi.mock('../../../components/pr-sidebar/MermaidDiagram', () => ({
  MermaidDiagram: 'MermaidDiagram'
}))
vi.mock('../../../components/MobileSourceCopyButton', () => ({
  MobileSourceCopyButton: 'MobileSourceCopyButton'
}))

const indent = {
  question: 'Tabs or spaces?',
  multiSelect: false,
  options: [{ label: 'Tabs' }, { label: 'Spaces' }]
}
const fruit = {
  question: 'Which fruit?',
  multiSelect: false,
  options: [{ label: 'Apple' }, { label: 'Banana' }]
}

let tree: ReactTestRenderer

function render(
  prompt: AskPrompt,
  onAnswer = vi.fn(async () => true),
  onCancel = vi.fn(async () => true)
): typeof onAnswer {
  vi.useFakeTimers()
  act(() => {
    tree = create(createElement(MobileNativeChatAsk, { prompt, onAnswer, onCancel }))
  })
  return onAnswer
}

function press(label: string): void {
  const row = tree.root.find((node) => node.props.label === label)
  act(() => row.props.onPress())
}

async function submit(label = 'Submit'): Promise<void> {
  const button = tree.root.find(
    (node) =>
      isHost(node, 'Pressable') && node.findAll((n) => n.props.children === label).length > 0
  )
  expect(button.props.disabled).toBe(false)
  await act(async () => button.props.onPress())
}

async function passAutoAdvanceBeat(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(NATIVE_CHAT_QUESTION_AUTO_ADVANCE_MS)
  })
}

const isHost = (node: { type: unknown }, name: string): boolean => node.type === name

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('')
// Question text renders as chat markdown, so match a Text by its whole rendered content.
const shows = (text: string): boolean =>
  tree.root.findAll((node) => isHost(node, 'Text') && textOf(node) === text).length > 0

afterEach(() => {
  act(() => tree.unmount())
  vi.useRealTimers()
})

describe('MobileNativeChatAsk single-select auto-advance', () => {
  it.each(['unknown', 'cursorless acknowledgement', 'retired before acknowledgement'] as const)(
    'composes the actual phone sender, projector and async form through %s',
    async (outcome) => {
      vi.useFakeTimers()
      let listener: ((value: unknown) => void) | undefined
      let reply: ((value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void) | undefined
      let id = ''
      const sendRequest = vi.fn<RpcClient['sendRequest']>(async (method, params) => {
        if (method !== 'agentSession.send') {
          return ok({ models: [], current: {} })
        }
        id = String(fieldsOf(fieldsOf(params).envelope).clientOperationId)
        return new Promise((resolve) => {
          reply = resolve
        })
      })
      const client: RpcClient = {
        sendRequest,
        subscribe: vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
          if (_method === 'agentSession.subscribe') {
            listener = onData
          }
          return () => {}
        }),
        updateTerminalSubscriptionViewport: () => {},
        getState: () => 'connected',
        getReconnectAttempt: () => 0,
        getLastConnectedAt: () => null,
        onStateChange: () => () => {},
        notifyForeground: () => {},
        close: () => {}
      }
      const onSendError = vi.fn()
      let structured: ReturnType<typeof useMobileStructuredAgentSession>
      function Chat() {
        structured = useMobileStructuredAgentSession({
          client,
          pairedHostClient: client,
          sessionId: 'session-1',
          sourceIdentity: 'host-a\0workspace-a',
          enabled: true,
          connected: true,
          agent: 'codex',
          hostSupport: null,
          onSendError
        })
        const scan = scanPendingAsks(structured.session.messages)
        const question = useMobileStructuredAsyncQuestion({
          structured,
          pendingAsk: aggregateAsyncQuestions(scan.contributors, 'host/epoch'),
          transcriptLoading: structured.session.transcriptLoading
        })
        return (
          question.ask &&
          createElement(MobileNativeChatAsk, {
            prompt: question.ask,
            answerPending: scan.answerPending,
            answerSendSource: {
              messages: structured.session.messages,
              submissions: structured.submissions
            },
            onAnswer: (selections, onCreated) =>
              question.answer!(question.ask!, selections, onCreated)
          })
        )
      }
      await act(async () => {
        tree = create(createElement(Chat))
      })
      const asked = {
        itemId: 'ask',
        sequence: 2,
        revision: 1,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [
            {
              type: 'tool-call',
              name: 'request_user_input_async',
              input: { questions: [{ title: 'Tabs or spaces?', options: ['Tabs', 'Spaces'] }] }
            }
          ]
        }
      } satisfies AgentJournalRenderItem
      act(() => listener!(snapshotEvent({ items: [asked] })))
      press('Spaces')
      await passAutoAdvanceBeat()
      const button = () =>
        tree.root.find(
          (node) =>
            isHost(node, 'Pressable') &&
            node.findAll((child) => child.props.children === 'Submit').length > 0
        )
      const sends = () =>
        sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
      expect(sends()).toHaveLength(1)
      const original = structured!.session.messages.find((row) => row.role === 'user')!
      expect(original).toMatchObject({
        id: agentJournalSubmissionKey(id),
        deliveryState: 'unknown',
        journalPosition: { sequence: 2.5 },
        blocks: [{ type: 'text', text: '> Tabs or spaces?\n\nSpaces' }]
      })
      expect(button().props.disabled).toBe(true)
      if (outcome === 'retired before acknowledgement') {
        act(() =>
          listener!(
            snapshotEvent({
              items: [asked],
              submissions: [
                {
                  ...acceptedSubmission(id),
                  dispatchState: 'unknown',
                  providerItemId: null
                }
              ]
            })
          )
        )
        expect(button().props.disabled).toBe(false)
        expect(structured!.session.messages.filter((row) => row.role === 'user')).toHaveLength(0)
        // The old proof may leave the current page before the original RPC answers.
        act(() => listener!(snapshotEvent({ items: [asked] })))
        expect(structured!.session.messages.filter((row) => row.role === 'user')).toHaveLength(0)
      }
      await act(async () =>
        reply!(
          outcome === 'unknown'
            ? ok({
                ok: false,
                refusal: { code: 'agent_session_operation_unknown', message: 'unknown' }
              })
            : ok({
                ok: true,
                replayed: false,
                fence: 3,
                value: { clientMessageId: id, submission: acceptedSubmission(id) }
              })
        )
      )
      expect(sends()).toHaveLength(1)
      expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
      expect(button().props.disabled).toBe(outcome === 'cursorless acknowledgement')
      const users = structured!.session.messages.filter((row) => row.role === 'user')
      if (outcome === 'retired before acknowledgement') {
        expect(users).toHaveLength(0)
        expect(button().props.disabled).toBe(false)
      } else {
        expect(users).toHaveLength(1)
        expect(users[0]).toEqual({
          ...original,
          deliveryState: outcome === 'unknown' ? 'unknown' : 'pending'
        })
        if (outcome === 'cursorless acknowledgement') {
          act(() => listener!(snapshotEvent({ items: [asked] })))
          expect(button().props.disabled).toBe(true)
          act(() =>
            listener!(
              snapshotEvent({
                items: [asked],
                submissions: [
                  {
                    ...acceptedSubmission(id),
                    dispatchState: 'unknown',
                    providerItemId: null
                  }
                ]
              })
            )
          )
          expect(button().props.disabled).toBe(false)
          expect(structured!.session.messages.filter((row) => row.role === 'user')).toHaveLength(0)
        }
      }
    }
  )

  it('owns the RPC-first echo and releases canonical uncertainty before an old reply can clear a retry', async () => {
    const prompt: AskPrompt = {
      questions: [indent],
      replyAsMessage: true
    }
    let source: NativeChatAnswerSource = { messages: [], submissions: [] }
    const replies: (() => void)[] = []
    const onAnswer = vi.fn(
      (_selections: AskAnswerSelection[], onCreated?: (id: string) => void) => {
        onCreated?.(['answer', 'retry', 'newer'][replies.length]!)
        return new Promise<boolean>((resolve) => replies.push(() => resolve(true)))
      }
    )
    vi.useFakeTimers()
    const update = () =>
      act(() =>
        tree.update(
          createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
        )
      )
    act(() => {
      tree = create(
        createElement(MobileNativeChatAsk, { prompt, onAnswer, answerSendSource: source })
      )
    })
    press('Spaces')
    await passAutoAdvanceBeat()
    const button = () =>
      tree.root.find(
        (node) =>
          isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Submit').length > 0
      )
    expect(button().props.disabled).toBe(true)
    source = {
      messages: [
        {
          id: agentJournalSubmissionKey('answer'),
          role: 'user',
          source: 'transcript',
          blocks: [],
          timestamp: 2,
          deliveryState: 'pending'
        }
      ],
      submissions: []
    }
    update()
    await act(async () => replies[0]!())
    expect(button().props.disabled).toBe(true)
    source = { messages: [], submissions: [] }
    update()
    expect(button().props.disabled).toBe(false)
    act(() => button().props.onPress())
    source = {
      messages: [],
      submissions: [
        {
          clientMessageId: 'retry',
          fence: 1,
          payloadFingerprint: 'retry',
          dispatchState: 'unknown',
          providerItemId: null,
          reason: null,
          submittedAt: 1,
          resolvedAt: null
        }
      ]
    }
    update()
    expect(button().props.disabled).toBe(false)
    act(() => button().props.onPress())
    expect(onAnswer).toHaveBeenCalledTimes(3)
    await act(async () => replies[1]!())
    // The third action has a distinct operation id on the actual sender; use it here too.
    source = { messages: [], submissions: [] }
    update()
    expect(button().props.disabled).toBe(true)
    expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
    await act(async () => replies[2]!())
  })

  it.each([false, true])(
    'cancels a scheduled step when delivery becomes pending (multiple: %s)',
    async (multiple) => {
      const prompt: AskPrompt = {
        questions: multiple ? [indent, fruit] : [indent],
        replyAsMessage: true
      }
      const onAnswer = render(prompt)
      press('Spaces')
      act(() =>
        tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: true }))
      )
      await passAutoAdvanceBeat()
      expect(onAnswer).not.toHaveBeenCalled()
      expect(shows('Tabs or spaces?')).toBe(true)
      expect(shows('Which fruit?')).toBe(false)
      expect(tree.root.find((node) => node.props.label === 'Spaces').props.selected).toBe(true)
      act(() =>
        tree.update(createElement(MobileNativeChatAsk, { prompt, onAnswer, answerPending: false }))
      )
      await submit(multiple ? 'Next' : 'Submit')
      if (multiple) {
        expect(shows('Which fruit?')).toBe(true)
      } else {
        expect(onAnswer).toHaveBeenCalledExactlyOnceWith([{ indices: [1] }], expect.any(Function))
      }
    }
  )

  it('sends nothing when the question is cancelled before the pick moves on', async () => {
    const onCancel = vi.fn(async () => true)
    const onAnswer = render(
      { questions: [indent] },
      vi.fn(async () => true),
      onCancel
    )

    press('Spaces')
    const cancel = tree.root.find(
      (node) =>
        isHost(node, 'Pressable') && node.findAll((n) => n.props.children === 'Cancel').length > 0
    )
    await act(async () => cancel.props.onPress())
    expect(onCancel).toHaveBeenCalledExactlyOnceWith()
    await passAutoAdvanceBeat()

    expect(onAnswer).not.toHaveBeenCalled()
  })
})
