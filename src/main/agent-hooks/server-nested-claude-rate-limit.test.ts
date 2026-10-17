import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const { probe } = vi.hoisted(() => ({
  probe: vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
}))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

type Transport = 'local' | 'relay'
type HookHost = {
  server: AgentHookServer
  pushed: ReturnType<typeof vi.fn>
  post: (pid: number, payload: Record<string, unknown>) => Promise<void>
}

/** Exercises the same process-bearing hook envelope on the local host and an SSH/WSL relay. */
async function withHookHost(transport: Transport, run: (host: HookHost) => Promise<void>) {
  const server = new AgentHookServer()
  const directory = mkdtempSync(join(tmpdir(), 'orca-claude-quota-'))
  const relay = new RelayAgentHookServer({
    endpointDir: directory,
    forward: (event) => server.ingestRemote(event, 'ssh-1')
  })
  const pushed = vi.fn()
  server.setListener(pushed)
  await server.start({ env: 'production', userDataPath: join(directory, 'desktop') })
  try {
    if (transport === 'relay') {
      await relay.start()
    }
    const post: HookHost['post'] = async (pid, payload) => {
      const body = buildBody(
        { session_id: `session-${pid}`, ...payload },
        {
          agentProcess: JSON.stringify({
            pid,
            platform: process.platform,
            startTime: `birth-${pid}`
          })
        }
      )
      const coordinates = relay.getCoordinates()
      const response =
        transport === 'local'
          ? await postHookEvent(server, body)
          : await fetch(`http://127.0.0.1:${coordinates.port}/hook/claude`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Connection: 'close',
                'X-Orca-Agent-Hook-Token': coordinates.token
              },
              body: JSON.stringify(body)
            })
      expect(response.status).toBe(204)
    }
    await run({ server, pushed, post })
  } finally {
    relay.stop()
    server.stop()
    rmSync(directory, { recursive: true, force: true })
  }
}

afterEach(() => {
  vi.useRealTimers()
  probe.mockReset()
  probe.mockResolvedValue('live')
})

describe.each(['local', 'relay'] as const)('nested Claude failures over %s', (transport) => {
  it.each(['working', 'done'] as const)(
    'does not announce 16 rate-limited child retries while the owner is %s',
    async (parentState) => {
      await withHookHost(transport, async ({ server, pushed, post }) => {
        vi.useFakeTimers({ toFake: ['Date'] })
        const start = Date.now()
        await post(4001, { hook_event_name: 'UserPromptSubmit', prompt: 'Parent research task' })
        if (parentState === 'done') {
          await post(4001, { hook_event_name: 'Stop' })
        }
        const before = server.getStatusSnapshot()
        pushed.mockClear()

        for (let attempt = 0; attempt < 16; attempt++) {
          vi.setSystemTime(start + (attempt + 1) * 15 * 60_000)
          const pid = 5000 + attempt
          await post(pid, { hook_event_name: 'SessionStart', source: 'startup' })
          await post(pid, { hook_event_name: 'UserPromptSubmit', prompt: 'Batch review item' })
          await post(pid, { hook_event_name: 'StopFailure', error: 'rate_limit' })
        }

        expect(server.getStatusSnapshot()).toEqual(before)
        expect(pushed).not.toHaveBeenCalled()
        expect(probe).toHaveBeenCalled()

        await post(4001, { hook_event_name: 'UserPromptSubmit', prompt: 'Parent retry' })
        pushed.mockClear()
        await post(4001, { hook_event_name: 'StopFailure', error: 'rate_limit' })
        expect(pushed).toHaveBeenCalledOnce()
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          providerSession: { id: 'session-4001' },
          mainAgent: { state: 'done', outcome: 'failure' }
        })
      })
    }
  )

  it('keeps the owner when its process cannot be checked', async () => {
    await withHookHost(transport, async ({ server, pushed, post }) => {
      await post(4001, { hook_event_name: 'UserPromptSubmit', prompt: 'Parent research task' })
      const before = server.getStatusSnapshot()
      pushed.mockClear()
      probe.mockResolvedValue('unverifiable')
      await post(5001, { hook_event_name: 'UserPromptSubmit', prompt: 'Child task' })
      await post(5001, { hook_event_name: 'StopFailure', error: 'rate_limit' })
      expect(server.getStatusSnapshot()).toEqual(before)
      expect(pushed).not.toHaveBeenCalled()
    })
  })

  it('accepts the first replacement hook after the host proves the owner exited', async () => {
    await withHookHost(transport, async ({ server, post }) => {
      await post(4001, { hook_event_name: 'UserPromptSubmit', prompt: 'Old task' })
      probe.mockResolvedValue('exited')
      await post(5001, { hook_event_name: 'UserPromptSubmit', prompt: 'New task' })
      expect(probe).toHaveBeenCalled()
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'New task',
        providerSession: { id: 'session-5001' }
      })
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(true)
    })
  })

  it('preserves a child permission and accepts a new session from the same process', async () => {
    await withHookHost(transport, async ({ server, pushed, post }) => {
      await post(4001, { hook_event_name: 'UserPromptSubmit', prompt: 'Parent task' })
      await post(4001, {
        hook_event_name: 'SubagentStart',
        agent_id: 'a6324370b7bede0c7',
        agent_type: 'general-purpose'
      })
      await post(4001, {
        hook_event_name: 'PermissionRequest',
        agent_id: 'a6324370b7bede0c7',
        agent_type: 'general-purpose',
        tool_name: 'Bash',
        tool_input: { command: 'false' }
      })
      const waiting = server.getStatusSnapshot()
      pushed.mockClear()
      await post(5001, { hook_event_name: 'SessionStart', source: 'startup' })
      await post(5001, { hook_event_name: 'StopFailure', error: 'rate_limit' })
      expect(server.getStatusSnapshot()).toEqual(waiting)
      expect(pushed).not.toHaveBeenCalled()

      await post(4001, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'after-clear',
        prompt: 'New session in the same Claude process'
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        prompt: 'New session in the same Claude process',
        providerSession: { id: 'after-clear' }
      })
    })
  })
})
