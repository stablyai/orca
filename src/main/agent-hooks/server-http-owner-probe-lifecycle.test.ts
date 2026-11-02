import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
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

it.each(['stop', 'restart', 'disable', 're-enable'] as const)(
  'discards an old hook when %s interrupts its owner probe',
  async (action) => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    await idleClaude(server)
    let release: (() => void) | undefined
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('exited')
        })
    )
    const pending = postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'obsolete-codex',
        prompt: 'Obsolete turn'
      }),
      '/hook/codex'
    )
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    if (action === 'stop' || action === 'restart') {
      server.stop()
      if (action === 'restart') {
        await server.start({ env: 'production' })
        await idleClaude(server, 'replacement-claude')
      }
    } else {
      server.setStatusHooksEnabled(false)
      if (action === 're-enable') {
        server.setStatusHooksEnabled(true)
      }
    }
    const before = server.getStatusSnapshot()
    const changed = vi.fn()
    const emitted = vi.fn()
    server.subscribeStatusChanges(changed)
    server.setListener(emitted)
    emitted.mockClear()
    release?.()
    expect((await pending).status).toBe(204)
    expect(server.getStatusSnapshot()).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    expect(emitted).not.toHaveBeenCalled()
    if (action === 'restart' || action === 're-enable') {
      probe.mockResolvedValue('exited')
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'current-codex',
          prompt: 'Current turn'
        }),
        '/hook/codex'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'codex',
        providerSession: { id: 'current-codex' }
      })
    }
  }
)

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
