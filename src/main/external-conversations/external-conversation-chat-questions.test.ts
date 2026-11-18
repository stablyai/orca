import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalQuestion } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  attach,
  hostTestState,
  seedPrompt
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { chatPaneKey } from './external-conversation-chat'
import { answerChatPrompt, pendingChatPrompt } from './external-conversation-chat-prompts'

// A native chat's question on the real host: asked with buttons, answered as a click in Orca would.
const LINK: ExternalConversationLink = {
  source: 'slack',
  externalId: 'T1:C9:1:U5',
  paneKey: chatPaneKey(HOST_TEST_SESSION),
  sessionId: HOST_TEST_SESSION,
  bot: { kind: 'bot', botId: 'b1' },
  agent: 'codex',
  createdAt: 1
}
const live = new AbortController().signal
const PENDING = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}
const BRANCH: AgentJournalQuestion = {
  id: 'branch',
  question: 'Which branch?',
  header: 'Branch',
  multiSelect: false,
  options: [
    { id: 'journal-option-main', label: 'main' },
    { id: 'journal-option-release', label: 'release', description: 'the cut' }
  ]
}

function seedQuestions(questions: AgentJournalQuestion[]) {
  return seedPrompt({
    kind: 'question',
    question: questions[0]?.question ?? '',
    options: [],
    questions,
    resolution: PENDING
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: HOST_TEST_NOW })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a native chat’s question in a linked conversation', () => {
  it('is asked with its options by position, and a press answers it as Orca would', async () => {
    const { host, answerPrompt } = hostTestState()
    await attach()
    const { itemId } = await seedQuestions([BRANCH])

    expect(pendingChatPrompt(host, LINK)).toEqual({
      kind: 'question',
      promptId: itemId,
      question: 'Which branch?',
      header: 'Branch',
      options: [
        { id: '1', label: 'main' },
        { id: '2', label: 'release', description: 'the cut' }
      ]
    })
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, optionId: '3', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'option_not_offered' })
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, optionId: '2', signal: live })
    ).resolves.toEqual({ outcome: 'accepted' })
    expect(answerPrompt).toHaveBeenCalledOnce()
    expect(answerPrompt.mock.calls[0]?.[0]).toMatchObject({
      kind: 'question',
      response: {
        kind: 'answers',
        answers: [{ questionId: 'branch', optionIds: ['journal-option-release'] }]
      }
    })
  })

  it('answers a single free-text question by reply and refuses text for options or a resolved prompt', async () => {
    const { host, answerPrompt } = hostTestState()
    await attach()
    const options = await seedQuestions([BRANCH])
    await expect(
      answerChatPrompt(host, LINK, { promptId: options.itemId, text: 'release', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'option_not_offered' })
    const { itemId } = await seedQuestions([
      { ...BRANCH, id: 'reason', options: [], freeTextQuestionId: 'reason' }
    ])
    expect(pendingChatPrompt(host, LINK)).toMatchObject({ promptId: options.itemId })
    await expect(
      answerChatPrompt(host, LINK, {
        promptId: itemId,
        text: 'Keep the release small.',
        signal: live
      })
    ).resolves.toEqual({ outcome: 'accepted' })
    expect(answerPrompt.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'question',
      response: {
        kind: 'answers',
        answers: [{ questionId: 'reason', optionIds: [], other: 'Keep the release small.' }]
      }
    })
    await expect(
      answerChatPrompt(host, LINK, { promptId: itemId, text: 'again', signal: live })
    ).resolves.toEqual({ outcome: 'refused', reason: 'prompt_not_pending' })
  })
})
