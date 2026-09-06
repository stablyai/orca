import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hooks/server'
import { GOOD_PANE, PANE, postHookEvent } from '../../agent-hooks/server.test-fixtures'
import { canvasMessagingFixture } from './canvas-messaging-test-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => '/unused-canvas-native-replies' } }))

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close()
  }
})

describe('native hook reply transport', () => {
  it.each(['codex', 'claude', 'cursor'] as const)(
    'returns %s final prose via the authenticated hook endpoint exactly once',
    async (provider) => {
      const server = new AgentHookServer()
      await server.start({ env: 'production' })
      const f = await canvasMessagingFixture(provider, {
        contexts: server.canvasContexts,
        panes: { a: PANE, b: GOOD_PANE }
      })
      const unsubscribe = server.subscribeEnrichedStatus((event) =>
        f.service.observeAgentHook(event)
      )
      cleanup.push(() => {
        unsubscribe()
        f.service.stop()
        server.stop()
        f.db.close()
      })
      f.runtime.getTerminalAgentStatus.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
      const original = f.service.send(f.input())
      await f.settle()
      const prompt = f.runtime.sendTerminalAgentPrompt.mock.calls[0][1]
      const post = async (payload: Record<string, unknown>) => {
        const response = await postHookEvent(
          server,
          {
            paneKey: GOOD_PANE,
            tabId: 'tab-good',
            worktreeId: 'folder-workspace',
            env: 'production',
            launchToken: 'b',
            payload: { session_id: 'session-b', conversation_id: 'session-b', ...payload }
          },
          `/hook/${provider}`
        )
        expect(response.status).toBe(204)
        await response.text()
      }
      await post({
        hook_event_name: provider === 'cursor' ? 'beforeSubmitPrompt' : 'UserPromptSubmit',
        prompt
      })
      f.runtime.getTerminalAgentStatus.mockResolvedValue({
        isRunningAgent: true,
        status: 'working'
      })
      const answer = 'Starting at 0: 3. Starting at 1: 5.'
      if (provider === 'cursor') {
        await post({ hook_event_name: 'stop', status: 'completed' })
        await post({ hook_event_name: 'afterAgentResponse', text: answer })
        await post({ hook_event_name: 'afterAgentResponse', text: answer })
      } else {
        await post({ hook_event_name: 'Stop', last_assistant_message: answer })
        await post({ hook_event_name: 'Stop', last_assistant_message: answer })
      }
      await f.settle()
      expect(f.service.inbox('canvas', PANE, 'a')).toEqual([
        expect.objectContaining({ replyTo: original.id, body: answer })
      ])
      expect(f.service.inbox('canvas', PANE, 'a')).toEqual([])
    }
  )
})
