// A linked chat's pending approval or question as the connector shows it, and an answer pressed there.
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { PendingPrompt } from '../../shared/agent-status/contracts/agent-pending-prompt'
import type {
  AgentJournalQuestion,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  CONNECTOR_PROMPT_LIMITS,
  type ConnectorAnswer
} from '../../shared/connectors/connector-cloud-contract'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { agentSessionPromptQuestions } from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { refusalOf } from './external-conversation-chain'
import {
  callerFor,
  envelope,
  type ConversationChat,
  type ConversationChatHost,
  currentChat
} from './external-conversation-chat'
import { refused, type Delivery } from './external-conversation-types'

/** The first pending prompt as of the chat's last status publish. */
export function pendingPromptItem(
  chat: ConversationChat | null,
  link: ExternalConversationLink
): AgentJournalRenderItem | null {
  return chat?.publishedWork(link.sessionId)?.actionablePrompts[0] ?? null
}

/** One question picked from its options, as buttons can ask it; free text and multi-select stay in Orca. */
function buttonQuestion(item: AgentJournalRenderItem): AgentJournalQuestion | null {
  if (item.body.kind !== 'question') {
    return null
  }
  const questions = agentSessionPromptQuestions(item.body)
  const [question] = questions
  return questions.length === 1 && question && !question.multiSelect && question.options.length > 0
    ? question
    : null
}

function replyQuestion(item: AgentJournalRenderItem): AgentJournalQuestion | null {
  if (item.body.kind !== 'question') {
    return null
  }
  const questions = agentSessionPromptQuestions(item.body)
  const [question] = questions
  return questions.length === 1 && question?.freeTextQuestionId && question.options.length === 0
    ? question
    : null
}

function questionText(item: AgentJournalRenderItem): string | undefined {
  if (item.body.kind !== 'question') {
    return undefined
  }
  const questions = agentSessionPromptQuestions(item.body)
  const text = questions
    .map((question, index) =>
      [
        question.header,
        `${questions.length > 1 ? `${index + 1}. ` : ''}${question.question}`,
        ...question.options.map((option) => option.label)
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n')
  let result = ''
  let bytes = 0
  for (const char of text) {
    bytes += Buffer.byteLength(char)
    if (bytes > CONNECTOR_PROMPT_LIMITS.maxTextBytes) {
      break
    }
    result += char
  }
  return result || undefined
}

// Options travel by position: a journal option id can be longer than the wire's ids allow.
const optionWireId = (index: number): string => String(index + 1)

/** Approvals and one-pick questions are answerable here; anything else only Orca's chat view can answer. */
export function pendingChatPrompt(
  chat: ConversationChat | null,
  link: ExternalConversationLink
): PendingPrompt | null {
  const item = pendingPromptItem(chat, link)
  if (!item) {
    return null
  }
  const { body } = item
  const promptId = item.itemId
  const question = buttonQuestion(item)
  if (question) {
    return {
      kind: 'question',
      promptId,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      options: question.options.map(({ label, description }, index) => ({
        id: optionWireId(index),
        label,
        ...(description ? { description } : {})
      }))
    }
  }
  const tool = body.kind === 'approval' ? body.displayName || body.title : ''
  if (body.kind !== 'approval' || !tool) {
    return {
      kind: 'unsupported',
      promptId,
      ...(link.bot
        ? { text: questionText(item), ...(replyQuestion(item) ? { byReply: true as const } : {}) }
        : {})
    }
  }
  const summary = body.description || body.detail
  return {
    kind: 'approval',
    promptId,
    tool,
    ...(summary ? { summary } : {}),
    options: body.options.map(({ id, label, description }) => ({
      id,
      label,
      ...(description ? { description } : {})
    }))
  }
}

/** The host fields of an answer, as a click in Orca would send them; null when not offered. */
function answerFields(item: AgentJournalRenderItem, answer: ConnectorAnswer) {
  const target = { itemId: item.itemId, expectedRevision: item.revision }
  if (answer.text !== undefined) {
    const question = replyQuestion(item)
    return question
      ? {
          kind: 'question' as const,
          fields: {
            ...target,
            answers: [{ questionId: question.id, optionIds: [], other: answer.text }]
          }
        }
      : null
  }
  const { optionId } = answer
  if (item.body.kind === 'approval') {
    return item.body.options.some((option) => option.id === optionId)
      ? { kind: 'approval' as const, fields: { ...target, optionId } }
      : null
  }
  const question = buttonQuestion(item)
  const option = question?.options.find((_, index) => optionWireId(index) === optionId)
  return question && option
    ? {
        kind: 'question' as const,
        fields: { ...target, answers: [{ questionId: question.id, optionIds: [option.id] }] }
      }
    : null
}

export async function answerChatPrompt(
  chat: ConversationChat | null,
  link: ExternalConversationLink,
  answer: { promptId: string; signal: AbortSignal } & ConnectorAnswer
): Promise<Delivery> {
  const work = await chat?.currentWork(link.sessionId)
  const item = work?.actionablePrompts().find(({ itemId }) => itemId === answer.promptId)
  if (!chat || !item) {
    return refused('prompt_not_pending')
  }
  if (answer.text === undefined && item.body.kind !== 'approval' && !buttonQuestion(item)) {
    return refused('prompt_unsupported')
  }
  const answering = answerFields(item, answer)
  if (!answering) {
    return refused('option_not_offered')
  }
  const { kind, fields } = answering
  const mutation = envelope(chat, link, `agentSession.respondTo:${kind}`, fields)
  if (!mutation || answer.signal.aborted) {
    return refused(mutation ? refusalOf(answer.signal) : 'agent_not_reachable')
  }
  try {
    const result = await chat.respondToPrompt(callerFor(link), {
      ...fields,
      kind,
      envelope: mutation
    })
    if (result.ok) {
      return { outcome: 'accepted' }
    }
    const { code } = result.refusal
    return refused(
      code === 'agent_session_item_revision_stale' || code === 'agent_session_already_resolved'
        ? 'prompt_not_pending'
        : 'agent_not_reachable'
    )
  } catch {
    return { outcome: 'unknown', reason: 'writer_failed' }
  }
}

export function chatPromptFacts(chats: ConversationChatHost | undefined) {
  return {
    pendingPrompt: (link: ExternalConversationLink) => pendingChatPrompt(currentChat(chats), link),
    turnOpener: (sessionId: string) =>
      currentChat(chats)?.publishedWork(sessionId)?.activeTurnOpener ?? null,
    turnStartedAt: (sessionId: string) => {
      const item = currentChat(chats)?.publishedWork(sessionId)?.activeTurn?.item
      return item ? (readAgentJournalTurn(item.body)?.startedAt ?? item.observedAt) : null
    },
    turnPlan: async (sessionId: string) => {
      const reads = await currentChat(chats)?.journalReads(sessionId)
      return (await reads?.latestTaskList()) ?? null
    },
    resolvedPrompt: async (sessionId: string, itemId: string) => {
      const reads = await currentChat(chats)?.journalReads(sessionId)
      return (await reads?.item(itemId)) ?? null
    }
  }
}
