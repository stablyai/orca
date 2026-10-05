import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalSubmission } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatAsyncAnswerSendResult } from '../../../src/shared/native-chat-async-question-card-state'
import type {
  NativeChatAsyncQuestion,
  NativeChatAsyncQuestionsView
} from '../../../src/shared/native-chat-async-questions'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatPendingMessage } from './mobile-native-chat-pending-echo'
import {
  useMobileNativeChatAsyncQuestions,
  type MobileNativeChatAsyncQuestionsModel
} from './use-mobile-native-chat-async-questions'

const q = (key: string): NativeChatAsyncQuestion => ({ key, index: 0, title: `${key}?` })
const ready = (...questions: NativeChatAsyncQuestion[]): NativeChatAsyncQuestionsView => ({
  state: 'ready',
  questions
})

type Props = {
  view: NativeChatAsyncQuestionsView
  structured: boolean
  scopeKey: string
  pending?: MobileNativeChatPendingMessage[]
  messages?: NativeChatMessage[]
  submissions?: AgentJournalSubmission[]
}

const echo = (
  text: string,
  asyncAnswers: Record<string, string>
): MobileNativeChatPendingMessage => ({
  id: 'pending-1',
  text,
  expectedOccurrence: 1,
  baselineTailMessageId: null,
  baselineResolved: true,
  asyncAnswers
})

const submission = (
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission => ({
  clientMessageId,
  fence: 1,
  payloadFingerprint: 'f',
  dispatchState,
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null
})

describe('useMobileNativeChatAsyncQuestions', () => {
  let renderer: ReactTestRenderer | null = null
  let model: MobileNativeChatAsyncQuestionsModel | null = null
  let resolveSend: (outcome: NativeChatAsyncAnswerSendResult) => void = () => {}
  const pending = (): Promise<NativeChatAsyncAnswerSendResult> =>
    new Promise((resolve) => {
      resolveSend = resolve
    })
  const answerTerminal = vi.fn(pending)
  const answerStructured = vi.fn(pending)

  function Harness(props: Props): null {
    model = useMobileNativeChatAsyncQuestions({
      ...props,
      pending: props.pending ?? [],
      messages: props.messages ?? [],
      submissions: props.submissions ?? [],
      answerTerminal,
      answerStructured
    })
    return null
  }
  const mount = (props: Props): void => {
    act(() => {
      renderer = create(createElement(Harness, props))
    })
  }
  const update = (props: Props): void => {
    act(() => renderer?.update(createElement(Harness, props)))
  }
  const settle = async (outcome: NativeChatAsyncAnswerSendResult): Promise<void> => {
    await act(async () => {
      resolveSend(outcome)
      await Promise.resolve()
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    model = null
    vi.clearAllMocks()
  })

  it('shows a question older than any loaded page: the card reads only the host set', () => {
    mount({ view: ready(q('old')), structured: false, scopeKey: 's' })
    expect(model?.open.map((question) => question.key)).toEqual(['old'])
  })

  it('keeps A through B arriving while A is edited, dismissed and sent', async () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    update({ view: ready(q('a'), q('b')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
    act(() => model!.dismiss('b'))
    act(() => model!.submit())
    expect(answerTerminal).toHaveBeenCalledWith('Question: a?\nAnswer: one', { a: 'one' })
    expect(model!.canSend).toBe(false)
    update({ view: ready(q('a'), q('b'), q('c')), structured: false, scopeKey: 's' })
    expect(model!.sending).toBe(true)
    await settle('accepted')
    expect(model!.edits.a).toBeUndefined()
  })

  it('routes the structured lane through its bridge, and keeps edits on rejection', async () => {
    mount({ view: ready(q('a')), structured: true, scopeKey: 's' })
    act(() => model!.edit('a', { option: 'x' }))
    act(() => model!.submit())
    expect(answerStructured).toHaveBeenCalledOnce()
    expect(answerTerminal).not.toHaveBeenCalled()
    await settle('rejected')
    expect(model!.edits.a).toEqual({ option: 'x' })
    expect(model!.canSend).toBe(true)
  })

  it('reconnect while unknown: no duplicate send, the card stays with its edits', async () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    update({ view: { state: 'pending' }, structured: false, scopeKey: 's' })
    act(() => model!.submit())
    expect(answerTerminal).toHaveBeenCalledOnce()
    await settle('unknown')
    update({ view: ready(q('a')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
  })

  it('a queued answer whose queued message is deleted leaves the card shown and sendable', async () => {
    mount({ view: ready(q('a')), structured: true, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    await settle('queued')
    expect(model!.open).toHaveLength(1)
    act(() => model!.edit('a', { text: 'again' }))
    expect(model!.canSend).toBe(true)
  })

  it('clears a question’s state once the host set drops it, never on pending', () => {
    mount({ view: ready(q('a')), structured: false, scopeKey: 's' })
    act(() => model!.edit('a', { text: 'one' }))
    update({ view: { state: 'pending' }, structured: false, scopeKey: 's' })
    update({ view: ready(q('a')), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toEqual({ text: 'one' })
    update({ view: ready(), structured: false, scopeKey: 's' })
    expect(model!.edits.a).toBeUndefined()
  })

  it('terminal: holds the sent answer while its echo waits for the transcript', async () => {
    const props = { view: ready(q('a')), structured: false, scopeKey: 's' }
    mount(props)
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    await settle('accepted')
    // The accepted send's echo carries the answers until its row lands.
    update({ ...props, pending: [echo('Question: a?\nAnswer: one', { a: 'one' })] })
    expect(model!.edits.a).toEqual({ text: 'one' })
    expect([...model!.held]).toEqual(['a'])
    expect(model!.canSend).toBe(false)
    update({ ...props, pending: [] })
    expect(model!.edits.a).toBeUndefined()
    expect(model!.held.size).toBe(0)
  })

  it('terminal: gives the answer back once the agent records input its echo never will be', () => {
    const row = (id: string, role: 'user' | 'assistant', text: string): NativeChatMessage => ({
      id,
      role,
      blocks: [{ type: 'text', text }],
      timestamp: 1,
      source: 'transcript'
    })
    const props = { view: ready(q('a'), q('b')), structured: false, scopeKey: 's' }
    const answer = echo('Question: a?\nAnswer: one\n\nQuestion: b?\nAnswer: two', {
      a: 'one',
      b: 'two'
    })
    const sent = { ...answer, baselineTailMessageId: 'a0', queuedAhead: ['first, do this'] }
    const before = [row('u0', 'user', 'go'), row('a0', 'assistant', 'Asked.')]
    mount({ ...props, pending: [sent], messages: before })
    expect([...model!.held]).toEqual(['a', 'b'])
    // A send queued ahead of it and harness machinery land: still held.
    update({
      ...props,
      pending: [sent],
      messages: [
        ...before,
        row('u1', 'user', 'first, do this'),
        row('n1', 'user', '<system-reminder>context</system-reminder>')
      ]
    })
    expect([...model!.held]).toEqual(['a', 'b'])
    // Codex files the paste as a reply to `a` alone: the host drops `a`; `b` comes back.
    update({
      view: ready(q('b')),
      structured: false,
      scopeKey: 's',
      pending: [sent],
      messages: [
        ...before,
        row('u1', 'user', 'first, do this'),
        row('u2', 'user', '<send_user_message_question_reply>{"questionItemId":"a"}'),
        row('a2', 'assistant', 'Using one.')
      ]
    })
    expect(model!.held.size).toBe(0)
    expect(model!.edits.b).toEqual({ text: 'two' })
    expect(model!.canSend).toBe(true)
  })

  it('structured: holds the answer while its submission is pending, gives it back if refused', async () => {
    const props = { view: ready(q('a')), structured: true, scopeKey: 's' }
    mount(props)
    act(() => model!.edit('a', { option: 'x' }))
    act(() => model!.submit())
    await settle({ outcome: 'accepted', receipt: 'm1' })
    update({ ...props, submissions: [submission('m1', 'pending')] })
    expect(model!.edits.a).toEqual({ text: 'x' })
    expect([...model!.held]).toEqual(['a'])
    expect(model!.canSend).toBe(false)
    // A Stop before the agent drained the steered answer: the host refuses it.
    update({ ...props, submissions: [submission('m1', 'rejected')] })
    expect(model!.edits.a).toEqual({ text: 'x' })
    expect(model!.held.size).toBe(0)
    expect(model!.canSend).toBe(true)
  })

  it('structured: an accepted submission lets go of the answer for good', async () => {
    const props = { view: ready(q('a')), structured: true, scopeKey: 's' }
    mount(props)
    act(() => model!.edit('a', { text: 'one' }))
    act(() => model!.submit())
    await settle({ outcome: 'accepted', receipt: 'm1' })
    update({ ...props, submissions: [submission('m1', 'accepted')] })
    expect(model!.edits.a).toBeUndefined()
    expect(model!.sending).toBe(false)
    // Forgotten once accepted: a later reading of the same id can't bring it back.
    update({ ...props, submissions: [submission('m1', 'rejected')] })
    expect(model!.edits.a).toBeUndefined()
  })
})
