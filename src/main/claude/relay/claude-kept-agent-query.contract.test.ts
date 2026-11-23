import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeKeptAgentQuery } from './claude-kept-agent-query'

type Line = Record<string, unknown> & { request_id?: string; request?: Record<string, unknown> }

/** A real SDK query over a stand-in child: every line it writes, answered with `success`. */
async function sdkRig() {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr: new PassThrough(),
    killed: false,
    exitCode: null,
    kill: () => true
  })
  const written: Line[] = []
  let text = ''
  stdin.on('data', (chunk: Buffer) => {
    text += chunk.toString()
    const parts = text.split('\n')
    text = parts.pop() ?? ''
    for (const part of parts.filter(Boolean)) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SDK's own wire lines.
      const line = JSON.parse(part) as Line
      written.push(line)
      if (line.type === 'control_request') {
        const response = { subtype: 'success', request_id: line.request_id, response: {} }
        stdout.write(`${JSON.stringify({ type: 'control_response', response })}\n`)
      }
    }
  })
  const prompts: SDKUserMessage[] = []
  let wake: (() => void) | null = null
  const session = query({
    prompt: (async function* () {
      for (;;) {
        const next = prompts.shift()
        if (next) {
          yield next
        } else {
          await new Promise<void>((resolve) => (wake = resolve))
        }
      }
    })(),
    options: {
      pathToClaudeCodeExecutable: '/bin/false',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SDK only writes stdin and reads stdout of this stand-in.
      spawnClaudeCodeProcess: () => child as never
    }
  })
  await session.initializationResult()
  const push = (message: SDKUserMessage) => {
    prompts.push(message)
    wake?.()
  }
  return { session, written, push }
}

/** The kept-agent query, answering each request it writes with `success`. */
function keptRig() {
  const written: Line[] = []
  const kept: ClaudeKeptAgentQuery = new ClaudeKeptAgentQuery(async (text) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the kept query's own wire lines.
    const line = JSON.parse(text) as Line
    written.push(line)
    queueMicrotask(() =>
      kept.observe({
        type: 'control_response',
        response: { subtype: 'success', request_id: line.request_id, response: {} }
      })
    )
  }, {})
  return { kept, written }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

// Each call the chat makes on a running Claude agent, made on the SDK's query and the kept query.
const CALLS: [string, (query: ClaudeKeptAgentQuery) => Promise<unknown>][] = [
  ['interrupt', (q) => q.interrupt()],
  ['interrupt queued', (q) => q.interrupt({ cancelQueued: true })],
  ['set_model', (q) => q.setModel('claude-opus-5-5')],
  ['set_model default', (q) => q.setModel(undefined)],
  ['set_permission_mode', (q) => q.setPermissionMode('acceptEdits')],
  ['apply_flag_settings', (q) => q.applyFlagSettings({ model: 'claude-opus-5-5' })],
  ['stop_task', (q) => q.stopTask('task-1')],
  ['background_tasks', (q) => q.backgroundTasks('toolu-1')],
  ['mcp_status', (q) => q.mcpServerStatus()],
  ['get_context_usage', (q) => q.getContextUsage({ detail: 'summary' })],
  ['mcp_reconnect', (q) => q.reconnectMcpServer('srv')],
  ['mcp_toggle', (q) => q.toggleMcpServer('srv', false)],
  ['mcp_authenticate', (q) => q.mcpAuthenticate('srv')],
  ['mcp_oauth_callback_url', (q) => q.mcpSubmitOAuthCallbackUrl('srv', 'http://127.0.0.1/cb')],
  ['rename_session', (q) => q.renameSession('Title', 'sess-1')],
  ['set_prompt_suggestions_paused', (q) => q.setPromptSuggestionsPaused(true)],
  ['get_settings', (q) => q.getSettings()],
  ['cancel_async_message', (q) => q.cancelAsyncMessage('uuid-1')]
]

describe('kept Claude agent wire contract (pinned SDK)', () => {
  it('writes every control request exactly as the SDK does', async () => {
    const sdk = await sdkRig()
    const { kept, written } = keptRig()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the SDK's query has each of these methods at runtime (some are absent from its declaration).
    const sdkQuery = sdk.session as unknown as ClaudeKeptAgentQuery
    for (const [name, call] of CALLS) {
      const before = sdk.written.length
      await call(sdkQuery)
      const theirs = sdk.written.slice(before).filter((line) => line.type === 'control_request')
      written.length = 0
      await call(kept)
      expect({ name, request: written.map((line) => line.request) }).toEqual({
        name,
        request: theirs.map((line) => line.request)
      })
      expect(written.every((line) => typeof line.request_id === 'string')).toBe(true)
    }
    sdk.session.close()
  })

  it('writes a chat message exactly as the SDK does', async () => {
    const sdk = await sdkRig()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a dispatch-shaped envelope, with fields the declaration omits.
    const message = {
      type: 'user',
      session_id: 'sess-1',
      parent_tool_use_id: null,
      uuid: '11111111-2222-3333-4444-555555555555',
      priority: 'now',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    } as unknown as SDKUserMessage
    const before = sdk.written.length
    sdk.push(message)
    await settle()
    // The kept connection writes each message as one JSON line, unchanged.
    expect(sdk.written.slice(before)).toEqual([JSON.parse(JSON.stringify(message))])
    sdk.session.close()
  })
})
