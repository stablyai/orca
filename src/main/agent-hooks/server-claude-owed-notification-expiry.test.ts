// No hook fires at lease expiry, so the server must release owed-notification holds itself.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from '../../shared/claude-owed-task-notifications'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent, RUNNING_SHELL } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
// The fixture's owner process is fictional; the pane's owning Claude is still running.
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  // Real loopback POSTs need fake time to advance.
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

  it('drops what was owed when the owning Claude process exits', async () => {
    const server = await heldByAnOwedShell()
    try {
      await server.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, OWNER)
      vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)

      expect(server.row()).toMatchObject({ providerSessionOnly: true })
    } finally {
      server.stop()
    }
  })

  it('keeps what is owed when a nested Claude in the same pane exits', async () => {
    const server = await heldByAnOwedShell()
    try {
      await server.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, 5151)
      expect(server.row()).toMatchObject({ state: 'working' })
      expect(server.row().providerSessionOnly).toBeUndefined()

      vi.advanceTimersByTime(CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS)
      expect(server.row()).toMatchObject({ state: 'done' })
    } finally {
      server.stop()
    }
  })
})

const OWNER = 4242

async function heldByAnOwedShell() {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  const agentProcess = (pid: number) =>
    JSON.stringify({ pid, platform: 'darwin', startTime: 'Fri Oct  2 12:00:00 2026' })
  const post = (payload: Record<string, unknown>, pid = OWNER) =>
    postHookEvent(
      server,
      buildBody({ session_id: 'session-1', ...payload }, { agentProcess: agentProcess(pid) })
    )
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
  await post({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { backgroundTaskId: RUNNING_SHELL.id }
  })
  await post({ hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] })
  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })
  await post({ hook_event_name: 'Stop', background_tasks: [] })
  const row = () => {
    const entry = server.getStatusSnapshotForPane(PANE)[0]
    if (!entry) {
      throw new Error('the pane has no row')
    }
    return entry
  }
  return { post, row, stop: () => server.stop() }
}
