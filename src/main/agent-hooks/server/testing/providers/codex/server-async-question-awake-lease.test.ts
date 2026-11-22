import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindAgentAwakeToHookStatus } from '../../../../../power/agent-awake-hook-status-binding'
import { AgentAwakeService } from '../../../../../power/agent-awake-service'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('electron', () => ({ powerMonitor: {}, powerSaveBlocker: {} }))
vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const START = Date.parse('2026-01-01T00:00:00Z')
let awake: AgentAwakeService
let server: AgentHookServer
let userDataPath: string
let unbind: () => void

async function post(payload: Record<string, unknown>) {
  const body = buildBody({ session_id: 'session-1', turn_id: 'turn-1', ...payload })
  expect((await postHookEvent(server, body, '/hook/codex')).status).toBe(204)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(START)
  const assertion = { start: () => true, stop: () => {}, dispose: () => {} }
  awake = new AgentAwakeService({
    blocker: { start: () => 1, stop: () => {}, isStarted: () => true },
    linuxAssertion: assertion,
    macosAssertion: assertion,
    now: () => Date.now(),
    powerMonitor: null
  })
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-question-awake-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  unbind = bindAgentAwakeToHookStatus(server, awake)

  await post({ hook_event_name: 'UserPromptSubmit', prompt: 'Build the cache' })
  const question = {
    tool_name: 'request_user_input_async',
    tool_use_id: 'call-1',
    tool_input: { questions: [{ title: 'SQLite or Postgres?' }] }
  }
  await post({ hook_event_name: 'PreToolUse', ...question })
  await post({ hook_event_name: 'PostToolUse', ...question })
})

afterEach(() => {
  unbind()
  awake.dispose()
  server.stop()
  rmSync(userDataPath, { recursive: true, force: true })
  vi.useRealTimers()
})

// A question doesn't change the row's content, so only its hooks' arrival can renew the 2 h lease.
it('keeps the awake lease while Codex works behind a question for over two hours', async () => {
  for (let minute = 10; minute <= 150; minute += 10) {
    vi.setSystemTime(START + minute * 60_000)
    const tool = { tool_name: 'Bash', tool_input: { command: `build step ${minute}` } }
    await post({ hook_event_name: 'PreToolUse', ...tool })
    await post({ hook_event_name: 'PostToolUse', ...tool })
  }
  expect(awake.getWorkingAgentCount()).toBe(1)

  const publish = { tool_name: 'Bash', tool_input: { command: 'pnpm publish' } }
  await post({ hook_event_name: 'PreToolUse', ...publish, tool_use_id: 'publish' })
  await post({ hook_event_name: 'PermissionRequest', ...publish })
  expect(awake.getWorkingAgentCount()).toBe(0)

  await post({ hook_event_name: 'PostToolUse', ...publish, tool_use_id: 'publish' })
  expect(awake.getWorkingAgentCount()).toBe(1)
  vi.setSystemTime(START + 271 * 60_000)
  expect(awake.getWorkingAgentCount()).toBe(0)
})

// An MCP elicitation sends no hook; only Codex's OSC 7501 status says that it blocks.
it('releases the lease while Codex reports itself blocked behind a question', () => {
  const report = (state: 'working' | 'blocked') =>
    server.ingestProgramStatusFacet({ paneKey: PANE, facet: { state, observedAt: Date.now() } })
  report('blocked')
  expect(awake.getWorkingAgentCount()).toBe(0)
  report('working')
  expect(awake.getWorkingAgentCount()).toBe(1)
})

// Paired clients age a row out after 30 min unless its repeats count as fresh.
it('keeps a wait over a question fresh while other calls repeat its row', async () => {
  await post({
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm publish' }
  })
  const fresh = vi.fn()
  const unsubscribe = server.subscribeStatusFreshness(fresh)
  await post({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'pnpm lint' }
  })
  unsubscribe()
  expect(fresh).toHaveBeenCalledWith(expect.objectContaining({ state: 'waiting' }))
})
