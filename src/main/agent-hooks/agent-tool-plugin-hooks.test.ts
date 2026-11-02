import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import {
  answerAgentToolPluginHooks,
  readAgentToolCall,
  setAgentToolHookTerminalResolver
} from './agent-tool-plugin-hooks'

const DECIDES = { 'x-orca-hook-decision': 'claude-pre-tool-use-v1' }

function installRunner(
  decide: (payload: unknown) => PluginHookChainOutcome | Promise<PluginHookChainOutcome>
) {
  const run = vi.fn(async (_event: PluginHookName, payload: unknown) => decide(payload))
  setPluginHookRunner({ wants: (event) => event.startsWith('agent.tool.'), run })
  return run
}

function post(payload: Record<string, unknown>) {
  return { paneKey: 'tab-1:0', worktreeId: 'repo::/w', payload: JSON.stringify(payload) }
}

const PRE = post({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /' },
  tool_use_id: 'toolu_1'
})

afterEach(() => {
  setPluginHookRunner(null)
  setAgentToolHookTerminalResolver(null)
  vi.useRealTimers()
})

describe('readAgentToolCall', () => {
  it('reads tool calls across agents’ field names and names the terminal', () => {
    setAgentToolHookTerminalResolver((paneKey) => (paneKey === 'tab-1:0' ? 'term_1' : null))
    expect(readAgentToolCall('claude', PRE)).toEqual({
      phase: 'before',
      payload: {
        agent: 'claude',
        workspaceId: 'repo::/w',
        terminalId: 'term_1',
        tool: 'Bash',
        input: { command: 'rm -rf /' },
        callId: 'toolu_1'
      }
    })
    expect(
      readAgentToolCall(
        'gemini',
        post({
          hook_event_name: 'AfterTool',
          tool_name: 'shell',
          tool_input: 'ls',
          tool_response: 'ok'
        })
      )
    ).toMatchObject({ phase: 'after', payload: { agent: 'gemini', input: 'ls', output: 'ok' } })
    expect(readAgentToolCall('claude', post({ hook_event_name: 'Stop' }))).toBeNull()
    expect(readAgentToolCall('claude', { paneKey: 'p', payload: '{not json' })).toBeNull()
  })
})

describe('answerAgentToolPluginHooks', () => {
  it('answers Claude Code with a deny, naming the plugin', async () => {
    installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'no rm' }))
    const answer = await answerAgentToolPluginHooks('claude', PRE, DECIDES)
    expect(JSON.parse(answer ?? 'null')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'acme.guard: no rm'
      }
    })
  })

  it('answers changed input without approving it, and nothing when unchanged', async () => {
    installRunner((payload) => ({
      kind: 'continue',
      payload: { ...Object(payload), input: { command: 'ls' } }
    }))
    expect(
      JSON.parse((await answerAgentToolPluginHooks('claude', PRE, DECIDES)) ?? 'null')
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls' } }
    })
    installRunner((payload) => ({ kind: 'continue', payload }))
    await expect(answerAgentToolPluginHooks('claude', PRE, DECIDES)).resolves.toBeNull()
  })

  it('only observes agents and scripts that cannot take an answer, and after-calls', async () => {
    const run = installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'x' }))
    await expect(answerAgentToolPluginHooks('codex', PRE, DECIDES)).resolves.toBeNull()
    await expect(answerAgentToolPluginHooks('claude', PRE, {})).resolves.toBeNull()
    await expect(
      answerAgentToolPluginHooks(
        'claude',
        post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }),
        DECIDES
      )
    ).resolves.toBeNull()
    expect(run.mock.calls.map(([event]) => event)).toEqual([
      'agent.tool.before',
      'agent.tool.before',
      'agent.tool.after'
    ])
  })

  it('fails open when the plugins take longer than the script waits', async () => {
    vi.useFakeTimers()
    installRunner(() => new Promise(() => undefined))
    const answer = answerAgentToolPluginHooks('claude', PRE, DECIDES)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(answer).resolves.toBeNull()
  })

  it('adds nothing when no plugin lists a tool hook', async () => {
    await expect(answerAgentToolPluginHooks('claude', PRE, DECIDES)).resolves.toBeNull()
  })
})
