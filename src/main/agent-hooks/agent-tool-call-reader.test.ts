import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { readAgentToolCall, setAgentToolHookTerminalResolver } from './agent-tool-call-reader'
import { _internals } from './server'
import { buildBody, PANE, type Body } from './server.test-fixtures'

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  setAgentToolHookTerminalResolver(null)
})

// Reads the call the way the server does: from the event status ingestion accepted.
function readAccepted(source: AgentHookSource, body: Body) {
  const owner = _internals.normalizeHookPayload(source, body, 'production')
  return owner ? readAgentToolCall(source, body, owner) : null
}

describe('readAgentToolCall', () => {
  it('reads Claude-style calls and names the owner’s terminal', () => {
    setAgentToolHookTerminalResolver((paneKey) => (paneKey === PANE ? 'term_1' : null))
    expect(
      readAccepted(
        'claude',
        buildBody({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
          tool_use_id: 'toolu_1'
        })
      )
    ).toEqual({
      phase: 'before',
      payload: {
        agent: 'claude',
        workspaceId: 'wt-1',
        terminalId: 'term_1',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
        callId: 'toolu_1'
      }
    })
    expect(
      readAccepted(
        'gemini',
        buildBody({
          hook_event_name: 'AfterTool',
          tool_name: 'shell',
          tool_input: 'ls',
          tool_response: 'ok'
        })
      )
    ).toMatchObject({ phase: 'after', payload: { agent: 'gemini', input: 'ls', output: 'ok' } })
    expect(readAccepted('claude', buildBody({ hook_event_name: 'Stop' }))).toBeNull()
  })

  it('reads Amp tool.call and tool.result', () => {
    const input = { command: 'pnpm test' }
    expect(
      readAccepted('amp', buildBody({ hook_event_name: 'tool.call', tool: 'shell_command', input }))
    ).toMatchObject({ phase: 'before', payload: { agent: 'amp', tool: 'shell_command', input } })
    expect(
      readAccepted(
        'amp',
        buildBody({ hook_event_name: 'tool.result', tool: 'shell_command', input, output: 'ok' })
      )
    ).toMatchObject({ phase: 'after', payload: { tool: 'shell_command', output: 'ok' } })
  })

  it('reads Copilot calls named only on the envelope or implied by the payload', () => {
    expect(
      readAccepted(
        'copilot',
        buildBody(
          { toolName: 'bash', toolArgs: '{"command":"ls"}' },
          { hookEventName: 'PreToolUse' }
        )
      )
    ).toMatchObject({ phase: 'before', payload: { tool: 'bash', input: { command: 'ls' } } })
    expect(
      readAccepted(
        'copilot',
        buildBody(
          { toolName: 'bash', toolArgs: '{"command":"ls"}', toolResult: { resultType: 'success' } },
          { hookEventName: 'PostToolUse' }
        )
      )
    ).toMatchObject({ phase: 'after', payload: { output: { resultType: 'success' } } })
    expect(
      readAccepted('copilot', buildBody({ toolCalls: [{ name: 'edit', args: '{"path":"a.ts"}' }] }))
    ).toMatchObject({ phase: 'before', payload: { tool: 'edit', input: { path: 'a.ts' } } })
  })

  it('reads Cursor shell and MCP executions, which carry no tool_name', () => {
    expect(
      readAccepted('cursor', buildBody({ hook_event_name: 'beforeShellExecution', command: 'ls' }))
    ).toMatchObject({ phase: 'before', payload: { tool: 'Shell', input: { command: 'ls' } } })
    expect(
      readAccepted(
        'cursor',
        buildBody({ hook_event_name: 'beforeMCPExecution', tool_name: 'fetch', url: 'https://x' })
      )
    ).toMatchObject({ phase: 'before', payload: { tool: 'fetch', input: 'https://x' } })
  })
})
