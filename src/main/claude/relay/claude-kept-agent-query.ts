import { randomBytes } from 'node:crypto'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import {
  QUERY_CLOSED_MESSAGE,
  type ClaudeControlQuery
} from '../sdk-transport/claude-agent-sdk-control-requests'

type ControlAnswer = { subtype?: unknown; response?: unknown; error?: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseField(answer: ControlAnswer, key: string): unknown {
  return isRecord(answer.response) ? answer.response[key] : undefined
}

type Initialization = Awaited<ReturnType<Query['initializationResult']>>

/**
 * The SDK query's control requests for a Claude agent that kept running while Orca was closed,
 * written over the relay in the SDK's exact wire shape (the contract test pins each against the
 * SDK). Answers arrive as `control_response` lines through `observe`.
 */
export class ClaudeKeptAgentQuery implements ClaudeControlQuery {
  private readonly pending = new Map<
    string,
    { resolve: (answer: ControlAnswer) => void; reject: (error: Error) => void }
  >()
  private closed: Error | null = null
  private readonly initialization: Promise<Initialization>

  constructor(
    private readonly write: (line: string) => Promise<void>,
    /** The kept agent's answer to the first app's `initialize`. */
    initialization: unknown
  ) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI's own initialize answer, which the SDK returns as is.
    this.initialization = Promise.resolve(initialization as Initialization)
  }

  /** True for the answer to a request this query is waiting on (cheap test first). */
  answers(line: string): boolean {
    if (!line.includes('control_response') || this.pending.size === 0) {
      return false
    }
    try {
      const message: unknown = JSON.parse(line)
      const response = isRecord(message) && isRecord(message.response) ? message.response : null
      return typeof response?.request_id === 'string' && this.pending.has(response.request_id)
    } catch {
      return false
    }
  }

  /** A `control_response` line answers one of this query's requests; false for anything else. */
  observe(message: Record<string, unknown>): boolean {
    if (message.type !== 'control_response' || !isRecord(message.response)) {
      return false
    }
    const answer = message.response
    const id = typeof answer.request_id === 'string' ? answer.request_id : null
    const waiter = id === null ? undefined : this.pending.get(id)
    if (!waiter || id === null) {
      // The last app's request, answered after it quit: nobody here asked.
      return true
    }
    this.pending.delete(id)
    if (answer.subtype === 'success') {
      waiter.resolve(answer)
    } else {
      waiter.reject(new Error(typeof answer.error === 'string' ? answer.error : 'request failed'))
    }
    return true
  }

  /** The agent ended: every unanswered request fails as the SDK's closed query does. */
  close(): void {
    this.closed ??= new Error(QUERY_CLOSED_MESSAGE)
    for (const waiter of this.pending.values()) {
      waiter.reject(this.closed)
    }
    this.pending.clear()
  }

  request(request: Record<string, unknown>): Promise<ControlAnswer> {
    if (this.closed) {
      return Promise.reject(this.closed)
    }
    const id = randomBytes(8).toString('hex')
    const answered = new Promise<ControlAnswer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    const line = JSON.stringify({ request_id: id, type: 'control_request', request })
    this.write(`${line}\n`).catch((error: unknown) => {
      const waiter = this.pending.get(id)
      this.pending.delete(id)
      waiter?.reject(error instanceof Error ? error : new Error(String(error)))
    })
    return answered
  }

  initializationResult(): ReturnType<Query['initializationResult']> {
    return this.initialization
  }

  async supportedModels(): ReturnType<Query['supportedModels']> {
    return (await this.initialization).models
  }

  async interrupt(options?: { cancelQueued?: boolean }) {
    const answer = await this.request({
      subtype: 'interrupt',
      ...(options?.cancelQueued === true ? { cancel_queued: true } : {})
    })
    const stillQueued = responseField(answer, 'still_queued')
    if (!Array.isArray(stillQueued)) {
      return undefined
    }
    const cancelled = responseField(answer, 'cancelled')
    const strings = (values: unknown[]) =>
      values.filter((value): value is string => typeof value === 'string')
    return {
      still_queued: strings(stillQueued),
      ...(Array.isArray(cancelled) ? { cancelled: strings(cancelled) } : {})
    }
  }

  async setPermissionMode(mode: Parameters<Query['setPermissionMode']>[0]): Promise<void> {
    await this.request({ subtype: 'set_permission_mode', mode })
  }

  async setModel(model?: string): Promise<void> {
    await this.request({ subtype: 'set_model', model })
  }

  async applyFlagSettings(settings: Parameters<Query['applyFlagSettings']>[0]): Promise<void> {
    await this.request({ subtype: 'apply_flag_settings', settings })
  }

  async stopTask(taskId: string): Promise<void> {
    await this.request({ subtype: 'stop_task', task_id: taskId })
  }

  async backgroundTasks(toolUseId: string): Promise<boolean> {
    const answer = await this.request({ subtype: 'background_tasks', tool_use_id: toolUseId })
    const backgrounded = responseField(answer, 'backgrounded')
    return typeof backgrounded === 'boolean' ? backgrounded : true
  }

  async getSettings(): Promise<unknown> {
    return (await this.request({ subtype: 'get_settings' })).response
  }

  async getContextUsage(
    options?: Parameters<Query['getContextUsage']>[0]
  ): ReturnType<Query['getContextUsage']> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI's own answer, returned as the SDK returns it.
    return (await this.request({ subtype: 'get_context_usage', ...options })).response as Awaited<
      ReturnType<Query['getContextUsage']>
    >
  }

  async mcpServerStatus(): ReturnType<Query['mcpServerStatus']> {
    const servers = responseField(await this.request({ subtype: 'mcp_status' }), 'mcpServers')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI's own server list, returned as the SDK returns it.
    return (Array.isArray(servers) ? servers : []) as Awaited<ReturnType<Query['mcpServerStatus']>>
  }

  async reconnectMcpServer(serverName: string): Promise<void> {
    await this.request({ subtype: 'mcp_reconnect', serverName })
  }

  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> {
    await this.request({ subtype: 'mcp_toggle', serverName, enabled })
  }

  async mcpAuthenticate(serverName: string, redirectUri?: string): Promise<unknown> {
    return (await this.request({ subtype: 'mcp_authenticate', serverName, redirectUri })).response
  }

  async mcpSubmitOAuthCallbackUrl(serverName: string, callbackUrl: string): Promise<unknown> {
    return (await this.request({ subtype: 'mcp_oauth_callback_url', serverName, callbackUrl }))
      .response
  }

  async renameSession(title: string, sessionId: string): Promise<void> {
    await this.request({ subtype: 'rename_session', title, source: 'host', session_id: sessionId })
  }

  async setPromptSuggestionsPaused(paused: boolean): Promise<void> {
    await this.request({ subtype: 'set_prompt_suggestions_paused', paused })
  }

  async cancelAsyncMessage(uuid: string): Promise<unknown> {
    const answer = await this.request({ subtype: 'cancel_async_message', message_uuid: uuid })
    return responseField(answer, 'cancelled')
  }
}
