import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import { filesystemPathToFileUri } from '../../shared/file-uri-path'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpJsonRpcServerRequest } from './acp-jsonrpc-connection'

export type AcpPendingPrompt = { id: number | string; kind: 'approval' | 'question' }

type SessionUpdate = {
  sessionUpdate?: string
  content?: { type?: string; text?: string }
  toolCallId?: string
  title?: string
  status?: string
  rawInput?: unknown
}

export function acpPromptBlocks(
  body: { blocks: { type: string; text?: string; path?: string }[] },
  imageCapable: boolean
): { ok: true; prompt: Record<string, unknown>[] } | { ok: false; reason: string } {
  const parts: Record<string, unknown>[] = []
  for (const block of body.blocks) {
    if (block.type === 'text' && block.text && block.text.length > 0) {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image-ref') {
      if (!imageCapable) {
        return { ok: false, reason: 'ACP session does not accept images' }
      }
      if (block.path) {
        parts.push({
          type: 'resource_link',
          uri: filesystemPathToFileUri(block.path),
          name: block.path
        })
      }
    }
  }
  return { ok: true, prompt: parts.length > 0 ? parts : [{ type: 'text', text: '' }] }
}

export function applyAcpSessionUpdate(input: {
  sessionId: string
  agent: string
  acpSessionId: string
  assistantRecordId: string
  assistant?: { text: string }
  params: unknown
  events?: StructuredAgentSessionAcquireInput['events']
}): void {
  if (!input.events) {
    return
  }
  const update = (input.params as { update?: SessionUpdate }).update
  if (!update) {
    return
  }
  if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
    const piece = update.content.text ?? ''
    if (piece.length === 0) {
      return
    }
    if (input.assistant) {
      input.assistant.text += piece
    }
    const text = input.assistant?.text ?? piece
    input.events.appendItem(
      {
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.acpSessionId,
        recordId: input.assistantRecordId
      },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
    )
    input.events.publish()
    return
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    const toolCallId = update.toolCallId ?? `tool-${update.title ?? 'call'}`
    const state =
      update.status === 'failed'
        ? 'failed'
        : update.status === 'completed'
          ? 'completed'
          : 'running'
    input.events.appendItem(
      {
        provider: 'legacy',
        agent: input.agent,
        sessionId: input.acpSessionId,
        recordId: toolCallId
      },
      {
        kind: 'tool-call',
        name: update.title ?? 'tool',
        input: update.rawInput ?? {},
        state
      }
    )
    input.events.publish()
  }
}

export function applyAcpServerRequest(input: {
  sessionId: string
  agent: string
  acpSessionId: string
  request: AcpJsonRpcServerRequest
  pending: Map<string, AcpPendingPrompt>
  events?: StructuredAgentSessionAcquireInput['events']
}): 'handled' | 'ignored' {
  if (!input.events) {
    return 'ignored'
  }
  if (input.request.method === 'session/request_permission') {
    const params = (input.request.params ?? {}) as {
      toolCall?: { title?: string; toolCallId?: string }
      options?: { optionId?: string; name?: string }[]
    }
    const itemId = params.toolCall?.toolCallId ?? `perm-${String(input.request.id)}`
    input.pending.set(itemId, { id: input.request.id, kind: 'approval' })
    const options = (params.options ?? []).map((option) => ({
      id: option.optionId ?? option.name ?? 'allow-once',
      label: option.name ?? option.optionId ?? 'Allow'
    }))
    appendPrompt(input, itemId, {
      kind: 'approval',
      title: params.toolCall?.title ?? 'Permission required',
      detail: null,
      options:
        options.length > 0
          ? options
          : [
              { id: 'allow-once', label: 'Allow once' },
              { id: 'reject-once', label: 'Reject' }
            ],
      resolution: pendingResolution()
    })
    return 'handled'
  }
  if (input.request.method === 'cursor/ask_question') {
    const params = (input.request.params ?? {}) as {
      questions?: { id?: string; prompt?: string; options?: { id?: string; label?: string }[] }[]
      question?: string
      options?: { id?: string; label?: string }[]
    }
    const question = params.questions?.[0]
    const itemId = question?.id ?? `question-${String(input.request.id)}`
    input.pending.set(itemId, { id: input.request.id, kind: 'question' })
    const options = (question?.options ?? params.options ?? []).map((option) => ({
      id: option.id ?? option.label ?? 'option',
      label: option.label ?? option.id ?? 'Option'
    }))
    appendPrompt(input, itemId, {
      kind: 'question',
      question: question?.prompt ?? params.question ?? 'Question',
      options,
      resolution: pendingResolution()
    })
    return 'handled'
  }
  if (input.request.method === 'cursor/create_plan') {
    const params = (input.request.params ?? {}) as { plan?: string; title?: string }
    const itemId = `plan-${String(input.request.id)}`
    input.pending.set(itemId, { id: input.request.id, kind: 'approval' })
    appendPrompt(input, itemId, {
      kind: 'approval',
      title: params.title ?? 'Plan approval',
      detail: params.plan ?? null,
      options: [
        { id: 'accept', label: 'Accept' },
        { id: 'reject', label: 'Reject' }
      ],
      resolution: pendingResolution()
    })
    return 'handled'
  }
  return 'ignored'
}

function pendingResolution() {
  return {
    state: 'pending' as const,
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
}

function appendPrompt(
  input: {
    agent: string
    acpSessionId: string
    events?: StructuredAgentSessionAcquireInput['events']
  },
  itemId: string,
  body: AgentJournalItemBody
): void {
  input.events?.appendItem(
    {
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.acpSessionId,
      recordId: itemId
    },
    body
  )
  input.events?.publish()
}
