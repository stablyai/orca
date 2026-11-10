import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from '../../plugins/hooks/plugin-hook-dispatch'
import { answerAgentToolPluginHooks } from './agent-tool-plugin-hooks'

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

const OWNER = { paneKey: 'tab-1:0', worktreeId: 'repo::/w', hookEventName: 'PreToolUse' }

afterEach(() => {
  setPluginHookRunner(null)
  vi.useRealTimers()
})

describe('answerAgentToolPluginHooks', () => {
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

  it('fails open when the plugins take longer than the script waits', async () => {
    vi.useFakeTimers()
    installRunner(() => new Promise(() => undefined))
    const answer = answerAgentToolPluginHooks('claude', PRE, DECIDES, OWNER)
    await vi.advanceTimersByTimeAsync(6_000)
    await expect(answer).resolves.toBeNull()
  })
})
