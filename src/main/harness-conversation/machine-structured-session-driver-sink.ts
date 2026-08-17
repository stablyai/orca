import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { HarnessConversationDriverEvent, HarnessConversationDriverSink } from './driver'
import {
  messageIdentity,
  promptIdentity,
  type MachineStructuredMessage
} from './machine-structured-session-values'

type DriverState = {
  processId: number
  providerSessionId: string | null
  endedReason: string | null
  context: AgentSessionContextSnapshot | null
  configuration: StructuredProviderConfiguration | null
  transcriptPath: string | null
}

type LiveSessionState = {
  activeTurn: string | null
  providerSessionId: string
  context: AgentSessionContextSnapshot | null
  configuration: StructuredProviderConfiguration | null
  transcriptPath: string | null
}

const EMPTY_RESOLUTION = {
  state: 'pending' as const,
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

export function createMachineStructuredSessionDriverSink(input: {
  identity: AgentSessionJournalIdentity
  events?: StructuredAgentSessionEventSink
  state: DriverState
  messages: Map<string, MachineStructuredMessage>
  prompts: Map<string, { kind: 'approval' | 'question'; requestId: string }>
  sessionRef: { current: LiveSessionState | null }
  onEnd: (reason: string) => void
}): HarnessConversationDriverSink {
  const appendMessage = (messageId: string): void => {
    const message = input.messages.get(messageId)
    if (!message || !input.events) {
      return
    }
    input.events.appendItem(
      {
        ...messageIdentity(input.identity, messageId),
        ...(message.turn ? { turn: message.turn } : {})
      },
      message.body,
      {
        coalescingKey: `message:${messageId}`
      }
    )
    input.events.publish({ coalescingKey: 'provider-message-publish' })
  }
  return {
    emit: (event) => emitProviderEvent(input, event, appendMessage),
    setProviderSessionId: (providerSessionId) => {
      input.state.providerSessionId = providerSessionId
      if (input.sessionRef.current) {
        input.sessionRef.current.providerSessionId = providerSessionId
      }
    },
    setConfiguration: (configuration) => {
      input.state.configuration = configuration
      if (input.sessionRef.current) {
        input.sessionRef.current.configuration = configuration
      }
    },
    setContext: (context) => {
      input.state.context = context
      if (input.sessionRef.current) {
        input.sessionRef.current.context = context
      }
    },
    setSubagents: () => undefined,
    setTranscriptPath: (transcriptPath) => {
      input.state.transcriptPath = transcriptPath
      if (input.sessionRef.current) {
        input.sessionRef.current.transcriptPath = transcriptPath
      }
    },
    setProcessId: (pid) => {
      input.state.processId = pid
    },
    end: (reason) => {
      input.state.endedReason = reason
      input.onEnd(reason)
    }
  }
}

function emitProviderEvent(
  input: Parameters<typeof createMachineStructuredSessionDriverSink>[0],
  event: HarnessConversationDriverEvent,
  appendMessage: (messageId: string) => void
): void {
  if (event.type === 'message.started' || event.type === 'message.completed') {
    const previous = input.messages.get(event.message.id)
    const turnId = input.sessionRef.current?.activeTurn
    input.messages.set(event.message.id, {
      ...(previous?.turn ? { turn: previous.turn } : turnId ? { turn: { turnId } } : {}),
      body: {
        kind: 'message',
        role: event.message.role,
        blocks: event.message.blocks,
        ...(event.message.assistantPhase ? { assistantPhase: event.message.assistantPhase } : {})
      }
    })
    appendMessage(event.message.id)
    return
  }
  if (event.type === 'message.delta') {
    const current = input.messages.get(event.messageId)
    const block = current?.body.blocks[event.blockIndex]
    if (current && block?.type === 'text' && block.text.length === event.offset) {
      const blocks = [...current.body.blocks]
      blocks[event.blockIndex] = { ...block, text: block.text + event.text }
      input.messages.set(event.messageId, { ...current, body: { ...current.body, blocks } })
      appendMessage(event.messageId)
    }
    return
  }
  if (!input.events) {
    return
  }
  if (event.type === 'permission') {
    const request = event.permission
    if (!request) {
      return
    }
    const identity = {
      ...promptIdentity(input.identity, request.id),
      ...(input.sessionRef.current?.activeTurn
        ? { turn: { turnId: input.sessionRef.current.activeTurn } }
        : {})
    }
    const itemId = agentJournalItemKey(identity)
    input.prompts.set(itemId, { kind: 'approval', requestId: request.id })
    input.events.appendItem(identity, {
      kind: 'approval',
      title: request.title,
      detail: request.detail ?? null,
      options: request.options.map(({ id, label }) => ({ id, label })),
      resolution: EMPTY_RESOLUTION
    })
    input.events.publish()
    return
  }
  const request = event.input
  if (!request) {
    return
  }
  const identity = {
    ...promptIdentity(input.identity, request.id),
    ...(input.sessionRef.current?.activeTurn
      ? { turn: { turnId: input.sessionRef.current.activeTurn } }
      : {})
  }
  const itemId = agentJournalItemKey(identity)
  const first = request.questions[0]
  input.prompts.set(itemId, { kind: 'question', requestId: request.id })
  input.events.appendItem(identity, {
    kind: 'question',
    question: first?.question ?? 'Input requested',
    options: (first?.options ?? []).map((option) => ({ id: option.label, label: option.label })),
    freeTextQuestionId: 'answers',
    questions: request.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      multiSelect: question.multiSelect ?? false,
      ...(question.secret !== undefined ? { secret: question.secret } : {}),
      ...(question.allowOther !== false ? { freeTextQuestionId: question.id } : {}),
      options: (question.options ?? []).map((option) => ({ ...option, id: option.label }))
    })),
    resolution: EMPTY_RESOLUTION
  })
  input.events.publish()
}
