import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { bindAgentAwakeToHookStatus } from '../../../../../power/agent-awake-hook-status-binding'
import { AgentAwakeService } from '../../../../../power/agent-awake-service'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, postHookEvent } from '../../server.test-fixtures'

vi.mock('electron', () => ({ powerMonitor: {}, powerSaveBlocker: {} }))
vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

afterEach(() => {
  vi.useRealTimers()
})

// A question doesn't change the row's content, so only its hooks' arrival can renew the 2 h lease.
it('keeps the awake lease while Codex works behind a question for over two hours', async () => {
  const start = Date.parse('2026-01-01T00:00:00Z')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  const assertion = { start: () => true, stop: () => {}, dispose: () => {} }
  const awake = new AgentAwakeService({
    blocker: { start: () => 1, stop: () => {}, isStarted: () => true },
    linuxAssertion: assertion,
    macosAssertion: assertion,
    now: () => Date.now(),
    powerMonitor: null
  })
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-question-awake-'))
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  const unbind = bindAgentAwakeToHookStatus(server, awake)
  const post = async (payload: Record<string, unknown>) => {
    const body = buildBody({ session_id: 'session-1', turn_id: 'turn-1', ...payload })
    expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
  }
  try {
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
    const question = {
      tool_name: 'request_user_input_async',
      tool_use_id: 'call-1',
      tool_input: { questions: [{ title: 'SQLite or Postgres?' }] }
    }
    await post({ hook_event_name: 'PreToolUse', ...question })
    await post({ hook_event_name: 'PostToolUse', ...question })

    for (let minute = 10; minute <= 150; minute += 10) {
      vi.setSystemTime(start + minute * 60_000)
      const tool = { tool_name: 'Bash', tool_input: { command: `build step ${minute}` } }
      await post({ hook_event_name: 'PreToolUse', ...tool })
      await post({ hook_event_name: 'PostToolUse', ...tool })
    }
    expect(awake.getWorkingAgentCount()).toBe(1)

    await post({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm publish' }
    })
    expect(awake.getWorkingAgentCount()).toBe(0)

    await post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm publish' }
    })
    expect(awake.getWorkingAgentCount()).toBe(1)
    vi.setSystemTime(start + 271 * 60_000)
    expect(awake.getWorkingAgentCount()).toBe(0)
  } finally {
    unbind()
    awake.dispose()
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
