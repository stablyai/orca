// A task notification that never arrives must not hold the pane working for the rest of the
// session: no hook fires at the end of the lease, so the server restates the row itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from '../../shared/claude-owed-task-notifications'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent, RUNNING_SHELL } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  // Why shouldAdvanceTime: the hooks are real loopback POSTs, which need the clock to move.
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance']
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('Claude owed task notification expiry on the hook server', () => {
  it('settles a pane whose launched shell vanished without a notification', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    const states: string[] = []
    server.setListener((event) => states.push(event.payload.state))
    const post = (payload: Record<string, unknown>) =>
      postHookEvent(server, buildBody({ session_id: 'session-1', ...payload }))
    try {
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
      await post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_response: { backgroundTaskId: RUNNING_SHELL.id }
      })
      await post({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
      await post({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })
      await post({ hook_event_name: 'Stop', background_tasks: [] })
      expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('working')

      vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)

      expect(server.getStatusSnapshotForPane(PANE)[0]?.state).toBe('done')
      expect(states.at(-1)).toBe('done')
    } finally {
      server.stop()
    }
  })
})
