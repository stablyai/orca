import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const servers: AgentHookServer[] = []
const parent = { pid: 4001, platform: 'linux', startTime: 'birth-4001' }
const child = { pid: 4002, platform: 'linux', startTime: 'birth-4002' }

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset().mockResolvedValue('live')
})

async function claudeHook(
  server: AgentHookServer,
  process: typeof parent,
  payload: Record<string, unknown>
): Promise<void> {
  await postHookEvent(server, buildBody(payload, { agentProcess: JSON.stringify(process) }))
}

async function parentWorking(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  await claudeHook(server, parent, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'claude-parent',
    prompt: 'Parent task'
  })
  return server
}

describe('a second Claude process in the same pane', () => {
  it('does not replace the live owner row when a nested claude -p fails', async () => {
    const server = await parentWorking()
    const emitted = vi.fn()
    server.setListener(emitted)
    await claudeHook(server, child, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-child',
      prompt: 'Child task'
    })
    await claudeHook(server, child, {
      hook_event_name: 'StopFailure',
      session_id: 'claude-child',
      error: 'rate_limit'
    })
    const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    expect(row).toMatchObject({
      state: 'working',
      prompt: 'Parent task',
      providerSession: { id: 'claude-parent' }
    })
    expect(emitted.mock.calls.some(([event]) => event.payload.state === 'done')).toBe(false)
  })

  it('lets a new Claude take the pane once the old owner process exited', async () => {
    const server = await parentWorking()
    probe.mockResolvedValue('exited')
    await claudeHook(server, child, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-next',
      prompt: 'Next task'
    })
    const row = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
    expect(row).toMatchObject({
      state: 'working',
      prompt: 'Next task',
      providerSession: { id: 'claude-next' }
    })
  })
})
