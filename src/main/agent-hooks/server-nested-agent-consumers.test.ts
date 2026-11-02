import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { buildRuntimeMobileAgentStatus } from '../runtime/runtime-mobile-agent-status-builder'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

afterEach(() => vi.restoreAllMocks())

describe('nested hooks retain the session used by mobile', () => {
  it('keeps the Claude mobile transcript through a nested Codex review', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'claude-parent',
          prompt: 'Review my changes'
        })
      )
      const checkConsumers = () => {
        const mobile = buildRuntimeMobileAgentStatus(
          null,
          {
            type: 'terminal',
            id: 'tab-1::leaf',
            parentTabId: 'tab-1',
            leafId: 'leaf',
            title: 'Claude',
            launchAgent: 'claude',
            isActive: true
          },
          null,
          null,
          () => server.getStatusSnapshot(),
          {
            getPaneKey: () => PANE,
            getLeaf: () => null,
            getTrackedTitle: () => null
          }
        )
        expect(mobile).toMatchObject({
          agentStatus: {
            agentType: 'claude',
            prompt: 'Review my changes',
            providerSession: { id: 'claude-parent' }
          }
        })
      }
      checkConsumers()
      for (const hook_event_name of [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'PermissionRequest',
        'Stop'
      ]) {
        const response = await postHookEvent(
          server,
          buildBody({
            hook_event_name,
            session_id: 'nested-codex',
            prompt: 'Nested review',
            tool_name: 'shell',
            model: 'gpt-6-astra'
          }),
          '/hook/codex'
        )
        expect(response.status).toBe(204)
        checkConsumers()
      }
    } finally {
      server.stop()
    }
  })
})
