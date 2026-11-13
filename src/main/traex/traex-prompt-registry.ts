import { agentJournalItemKey } from '../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionPromptResponse } from '../../shared/agent-session/agent-session-question-answer'
import type { ProviderTimelineRequestBody } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AgentSessionPromptUnavailableError } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type { TraexAppServerConnection, TraexServerRequest } from './traex-app-server-connection'
import type { TraexTimeline } from './traex-timeline'
import { traexRecord, traexText } from './traex-protocol'
import {
  pendingTraexPromptResolution,
  TRAEX_APPROVAL_LABELS,
  traexQuestionBody,
  traexPromptReply
} from './traex-prompt-content'

type OpenPrompt = {
  request: TraexServerRequest
  key: string
  body: ProviderTimelineRequestBody
  claimed: boolean
  withdrawn: boolean
  respond?: (reply: Record<string, unknown>) => Promise<void>
}

export class TraexPromptRegistry {
  private readonly open = new Map<string, OpenPrompt>()
  private sequence = 0

  constructor(
    private readonly connection: TraexAppServerConnection,
    private readonly timeline: TraexTimeline,
    private readonly threadId: string,
    private readonly onModeApproved?: (mode: 'plan' | 'default') => Promise<void>
  ) {}

  handle(request: TraexServerRequest, turn: string | null): void {
    const params = traexRecord(request.params)
    if (params.threadId !== this.threadId) {
      this.connection.reject(request.id, 'TRAE CLI request belongs to another thread')
      return
    }
    let body: ProviderTimelineRequestBody
    if (request.method === 'item/tool/requestUserInput') {
      body = traexQuestionBody(params.questions)
      if (params.isBlocking === false) {
        this.timeline.apply({
          type: 'item.close',
          item: `async-question:${agentJournalItemKey(this.timeline.requestItemId(JSON.stringify(request.id)))}`,
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [
              {
                type: 'text',
                text: body.questions?.map((question) => question.question).join('\n') ?? ''
              },
              {
                type: 'tool-call',
                name: 'request_user_input_async',
                input: {
                  questions: body.questions?.map((question) => ({
                    title: question.question,
                    multiSelect: question.multiSelect,
                    options: question.options.map((option) => option.label)
                  }))
                },
                state: 'completed'
              }
            ]
          },
          join: { thread: this.threadId, ...(turn ? { turn } : {}) }
        })
        this.connection.respond(request.id, { answers: {} })
        return
      }
    } else if (request.method === 'mode/changeRequested') {
      if (params.targetMode !== 'plan' && params.targetMode !== 'default') {
        return
      }
      body = {
        kind: 'approval',
        title: params.targetMode === 'plan' ? 'Switch to Plan mode' : 'Switch to Build mode',
        description: traexText(params.reason),
        detail:
          Array.isArray(params.allowedPrompts) && params.allowedPrompts.length
            ? JSON.stringify(params.allowedPrompts)
            : null,
        options: [
          { id: 'accept', label: 'Allow once' },
          { id: 'cancel', label: 'Keep current mode' }
        ],
        resolution: pendingTraexPromptResolution
      }
    } else if (request.method === 'mcpServer/elicitation/request') {
      const meta = traexRecord(params._meta),
        schema = traexRecord(params.requestedSchema)
      const properties = schema.properties
      const empty =
        params.requestedSchema == null ||
        (schema.type === 'object' &&
          properties !== null &&
          typeof properties === 'object' &&
          !Array.isArray(properties) &&
          Object.keys(properties).length === 0)
      if (
        meta.codex_approval_kind !== 'mcp_tool_call' ||
        params.mode !== 'form' ||
        !empty ||
        typeof params.turnId !== 'string'
      ) {
        this.connection.respond(request.id, { action: 'cancel', content: null, _meta: null })
        return
      }
      const persist = meta.persist
      const session =
        persist === 'session' || (Array.isArray(persist) && persist.includes('session'))
      body = {
        kind: 'approval',
        title: 'Run MCP tool',
        description: traexText(params.message),
        detail: traexText(params.serverName) ?? null,
        options: [
          { id: 'accept', label: 'Allow once' },
          ...(session ? [{ id: 'acceptForSession', label: 'Allow for this session' }] : []),
          { id: 'cancel', label: 'Cancel' }
        ],
        resolution: pendingTraexPromptResolution
      }
    } else if (
      request.method === 'item/commandExecution/requestApproval' ||
      request.method === 'item/fileChange/requestApproval'
    ) {
      const offered = Array.isArray(params.availableDecisions)
        ? params.availableDecisions
        : ['accept', 'acceptForSession', 'decline', 'cancel']
      body = {
        kind: 'approval',
        title:
          request.method === 'item/fileChange/requestApproval'
            ? 'Apply file changes'
            : 'Run command',
        description: traexText(params.reason),
        detail: traexText(params.command) ?? null,
        options: offered.flatMap((id) =>
          typeof id === 'string' && TRAEX_APPROVAL_LABELS[id]
            ? [{ id, label: TRAEX_APPROVAL_LABELS[id]! }]
            : []
        ),
        resolution: pendingTraexPromptResolution
      }
    } else {
      this.connection.reject(request.id, `Orca did not negotiate ${request.method}`)
      return
    }
    if (this.open.size >= 64) {
      this.connection.reject(request.id, 'TRAE CLI has too many pending prompts')
      return
    }
    const key = `${request.method}:${JSON.stringify(request.id)}:${++this.sequence}`
    const prompt: OpenPrompt = { request, key, body, claimed: false, withdrawn: false }
    if (request.method === 'mode/changeRequested') {
      const target = params.targetMode
      prompt.respond = async (reply) => {
        const decision = reply.decision === 'accept' ? 'approved' : 'cancelled'
        await this.connection.request('mode/change/respond', {
          threadId: this.threadId,
          requestId: request.id,
          decision
        })
        if (decision === 'approved' && (target === 'plan' || target === 'default')) {
          await this.onModeApproved?.(target)
        }
      }
    } else if (request.method === 'mcpServer/elicitation/request') {
      prompt.respond = async (reply) => {
        const accepted = reply.decision === 'accept' || reply.decision === 'acceptForSession'
        this.connection.respond(request.id, {
          action: accepted ? 'accept' : 'cancel',
          content: accepted ? {} : null,
          _meta: reply.decision === 'acceptForSession' ? { persist: 'session' } : null
        })
      }
    }
    this.open.set(agentJournalItemKey(this.timeline.requestItemId(key)), prompt)
    this.timeline.apply({
      type: 'request.open',
      request: key,
      body,
      outlivesTurn: true,
      join: { thread: this.threadId, ...(turn ? { turn } : {}) }
    })
  }

  async answer(
    itemId: string,
    response: AgentSessionPromptResponse | null,
    commit: () => Promise<void>
  ): Promise<void> {
    const prompt = this.open.get(itemId)
    if (!prompt || prompt.claimed || prompt.withdrawn || this.connection.closed) {
      throw new AgentSessionPromptUnavailableError(itemId)
    }
    const reply = traexPromptReply(prompt.body, response)
    prompt.claimed = true
    try {
      await commit()
    } catch (error) {
      prompt.claimed = false
      if (prompt.withdrawn) {
        this.open.delete(itemId)
      }
      throw error
    }
    this.open.delete(itemId)
    this.timeline.apply({ type: 'request.withdrawn', request: prompt.key })
    if (prompt.withdrawn || this.connection.closed) {
      throw new AgentSessionPromptUnavailableError(itemId)
    }
    if (prompt.respond) {
      await prompt.respond(reply)
    } else {
      this.connection.respond(prompt.request.id, reply)
    }
  }

  has(itemId: string): boolean {
    return this.open.has(itemId)
  }

  withdraw(requestId?: unknown): void {
    for (const [id, prompt] of this.open) {
      if (requestId !== undefined && requestId !== prompt.request.id) {
        continue
      }
      prompt.withdrawn = true
      this.timeline.apply({ type: 'request.withdrawn', request: prompt.key })
      if (!prompt.claimed) {
        this.open.delete(id)
      }
      if (requestId === undefined && !this.connection.closed) {
        if (prompt.respond) {
          void prompt.respond({ decision: 'cancel' }).catch(() => {})
        } else {
          this.connection.respond(
            prompt.request.id,
            prompt.body.kind === 'question' ? { answers: {} } : { decision: 'cancel' }
          )
        }
      }
    }
  }
}
