import type { ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import {
  answerAgentToolPluginHooks,
  respondAfterAgentToolPluginHooks
} from './agent-tool-plugin-hooks'

const DECIDES = { 'x-orca-hook-decision': 'claude-pre-tool-use-v1' }

function installRunner(
  decide: (payload: unknown) => PluginHookChainOutcome | Promise<PluginHookChainOutcome>
) {
  const run = vi.fn(async (_event: PluginHookName, payload: unknown) => decide(payload))
  setPluginHookRunner({ wants: (event) => event.startsWith('agent.tool.'), run })
  return run
}

function fakeResponse() {
  const res = { writeHead: vi.fn(), end: vi.fn(), socket: { setTimeout: vi.fn() } }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the responder calls only writeHead, end and socket.setTimeout.
  return { ...res, response: res as unknown as ServerResponse }
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

const OWNER = { paneKey: 'tab-1:0', worktreeId: 'repo::/w', hookEventName: 'PreToolUse' }

afterEach(() => {
  setPluginHookRunner(null)
  vi.useRealTimers()
})

describe('answerAgentToolPluginHooks', () => {
  it('answers Claude Code with a deny, naming the plugin', async () => {
    installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'no rm' }))
    const answer = await answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)
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
      JSON.parse((await answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)) ?? 'null')
    ).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { command: 'ls' } }
    })
    installRunner((payload) => ({ kind: 'continue', payload }))
    await expect(answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)).resolves.toBeNull()
  })

  it('only observes agents and scripts that cannot take an answer, and after-calls', async () => {
    const run = installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'x' }))
    await expect(answerAgentToolPluginHooks('codex', PRE, DECIDES, OWNER)).resolves.toBeNull()
    await expect(answerAgentToolPluginHooks('claude', PRE, {}, OWNER)).resolves.toBeNull()
    await expect(
      answerAgentToolPluginHooks(
        'claude',
        post({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }),
        DECIDES,
        { ...OWNER, hookEventName: 'PostToolUse' }
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
    const answer = answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(answer).resolves.toBeNull()
  })

  it('adds nothing when no plugin lists a tool hook', async () => {
    await expect(answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)).resolves.toBeNull()
  })

  it('answers 204 synchronously, without running a chain, when no plugin lists a tool hook', () => {
    const run = vi.fn()
    setPluginHookRunner({ wants: () => false, run })
    const res = fakeResponse()
    void respondAfterAgentToolPluginHooks(res.response, 'claude', PRE, DECIDES, OWNER)
    // Checked before any await: the reply is already written.
    expect(res.writeHead).toHaveBeenCalledWith(204)
    expect(res.end).toHaveBeenCalledOnce()
    expect(res.socket.setTimeout).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('skips plugins when status ingestion rejected or fenced the post', () => {
    const run = installRunner(() => ({ kind: 'deny', pluginKey: 'acme.guard', reason: 'x' }))
    const res = fakeResponse()
    void respondAfterAgentToolPluginHooks(res.response, 'claude', PRE, DECIDES, null)
    expect(res.writeHead).toHaveBeenCalledWith(204)
    expect(run).not.toHaveBeenCalled()
  })
})
