import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'
import type { FinishedCommand } from '../shared/command-foreground-tracker'

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const paneKey = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const toolUse = { tool_name: 'Bash', tool_input: { command: 'ls' } }
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  probe.mockReset()
  probe.mockResolvedValue('live')
})

async function startRelay() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-launch-end-'))
  const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  cleanups.push(async () => {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  })
  await server.start()
  const { port, token } = server.getCoordinates()
  const post = async (agent: string, payload: Record<string, unknown>, pid?: number) => {
    const response = await fetch(`http://127.0.0.1:${port}/hook/${agent}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        ...(pid
          ? {
              agentProcess: JSON.stringify({
                pid,
                platform: process.platform,
                startTime: `birth-${pid}`
              })
            }
          : {}),
        payload
      })
    })
    expect(response.status).toBe(204)
  }
  const codex = (event: string, extra = {}) =>
    post('codex', { hook_event_name: event, session_id: 'codex-x', ...extra })
  const last = () => forward.mock.lastCall?.[0]
  return { server, forward, post, codex, last }
}

const ran = (agent: string, promptReturned = true): FinishedCommand => ({
  foreground: { kind: 'agent', agent },
  startedAt: 0,
  finishedAt: Date.now() + 1,
  promptReturned: async () => promptReturned
})

describe('relay: the host ending the agent a finished command ran', () => {
  it("ends a typed Codex Ctrl-C'd mid-turn, drops its late hooks, revives on a new run", async () => {
    const { server, forward, codex, last } = await startRelay()
    await codex('UserPromptSubmit', { prompt: 'codex task' })
    await codex('PreToolUse', toolUse)
    expect(last()?.payload.state).toBe('working')
    await server.endCommand(paneKey, ran('codex'))
    expect(last()).toMatchObject({ providerSessionOnly: true, agentPresence: { ended: true } })
    const forwarded = forward.mock.calls.length
    await codex('Stop')
    await codex('PostToolUse', toolUse)
    expect(forward.mock.calls.length).toBe(forwarded)
    await codex('UserPromptSubmit', { prompt: 'next task' })
    expect(last()).toMatchObject({ payload: { state: 'working', prompt: 'next task' } })
    expect(last()?.providerSessionOnly).toBeFalsy()
  })

  it('keeps a Codex whose command another program held (`codex &`, then `ls`)', async () => {
    const { server, forward, codex } = await startRelay()
    await codex('UserPromptSubmit', { prompt: 'codex task' })
    const forwarded = forward.mock.calls.length
    await server.endCommand(paneKey, { ...ran('codex'), foreground: { kind: 'program' } })
    await server.endCommand(paneKey, ran('claude'))
    expect(forward.mock.calls.length).toBe(forwarded)
  })

  it('keeps a Codex when a fresh read finds a non-shell holding the terminal (a leaked end)', async () => {
    const { server, forward, codex } = await startRelay()
    await codex('UserPromptSubmit', { prompt: 'codex task' })
    const forwarded = forward.mock.calls.length
    await server.endCommand(paneKey, ran('codex', false))
    expect(forward.mock.calls.length).toBe(forwarded)
  })

  it('keeps a waiting guest visible, with its prompt, when a launched Claude is killed (e2e i)', async () => {
    const { server, post, codex, last } = await startRelay()
    await post(
      'claude',
      { hook_event_name: 'UserPromptSubmit', session_id: 'claude-a', prompt: 'claude task' },
      4001
    )
    await codex('UserPromptSubmit', { prompt: 'codex task' })
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    probe.mockResolvedValue('exited')
    await server.checkAgentPresence(paneKey)
    expect(last()).toMatchObject({ payload: { agentType: 'codex', prompt: 'codex task' } })
    await server.endCommand(paneKey, ran('claude'))
    await codex('PreToolUse', toolUse)
    expect(last()).toMatchObject({
      payload: { agentType: 'codex', prompt: 'codex task', toolName: 'Bash' }
    })
    expect(last()?.providerSessionOnly).toBeFalsy()
  })
})
