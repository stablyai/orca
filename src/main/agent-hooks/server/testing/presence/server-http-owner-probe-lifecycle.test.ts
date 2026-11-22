import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'
import type { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))
const servers: AgentHookServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset().mockResolvedValue('live')
})

async function idleClaude(server: AgentHookServer, session = 'claude-parent'): Promise<void> {
  for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name, session_id: session, prompt: session },
        {
          agentProcess: JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'birth' })
        }
      )
    )
  }
}

it('starts a new owner check after re-enabling without waiting on the discarded generation', async () => {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production' })
  await idleClaude(server)
  let release: (() => void) | undefined
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve('live')
      })
  )
  const postCodex = (session: string) =>
    postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: session }),
      '/hook/codex'
    )
  const obsolete = postCodex('obsolete-codex')
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  server.setStatusHooksEnabled(false)
  server.setStatusHooksEnabled(true)
  probe.mockResolvedValue('exited')
  const current = postCodex('current-codex')
  try {
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect((await current).status).toBe(204)
    expect(server.getStatusSnapshot()[0].providerSession?.id).toBe('current-codex')
  } finally {
    release?.()
    await Promise.all([obsolete, current])
  }
  expect(server.getStatusSnapshot()[0].providerSession?.id).toBe('current-codex')
})
