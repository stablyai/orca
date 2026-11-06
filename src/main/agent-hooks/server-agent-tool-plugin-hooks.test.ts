import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../shared/plugins/contributions/plugin-hook-contribution'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import { setAgentToolHookTerminalResolver } from './agent-tool-call-reader'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  setPluginHookRunner(null)
  setAgentToolHookTerminalResolver(null)
})

describe('AgentHookServer agent tool plugin hooks', () => {
  it('runs plugins only for calls status accepts, naming the owner’s terminal', async () => {
    const run = vi.fn(async (_event: PluginHookName, payload: unknown) => ({
      kind: 'continue' as const,
      payload
    }))
    setPluginHookRunner({ wants: (event) => event.startsWith('agent.tool.'), run })
    setAgentToolHookTerminalResolver((paneKey) => (paneKey === PANE ? 'term_1' : null))
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })
      const pre = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }

      // A post status cannot normalize (no event name) never reaches plugins.
      await expect(postHook({ tool_name: 'Bash' })).resolves.toMatchObject({ status: 204 })
      await expect(postHook(pre)).resolves.toMatchObject({ status: 204 })
      expect(run).toHaveBeenCalledOnce()
      expect(run.mock.calls[0]?.[1]).toMatchObject({ terminalId: 'term_1', tool: 'Bash' })

      // A closed tab's late hooks are fenced off from status, so plugins never see them.
      server.dropStatusEntriesByTabPrefix('tab-1')
      await expect(postHook(pre)).resolves.toMatchObject({ status: 204 })
      expect(run).toHaveBeenCalledOnce()
    } finally {
      server.stop()
    }
  })
})
