import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import { wslHookRelayConnectionId } from '../../../../../shared/agent-hook-listener/transport/wsl-hook-relay-contract'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'live')
)
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))

describe("a command mark in a local agent's pane", () => {
  let server: AgentHookServer
  let userDataPath: string
  let exits: string[]

  beforeEach(async () => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-marked-exit-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    exits = []
    server.setTerminalPaneLifecycle({
      ownsProcess: () => true,
      isStopping: () => false,
      isReversibleStop: () => false,
      isPlaced: () => true,
      agentExited: (paneKey) => exits.push(paneKey)
    })
    const agentProcess = JSON.stringify({
      pid: 4001,
      platform: process.platform,
      startTime: 'birth-4001'
    })
    for (const event of ['SessionStart', 'UserPromptSubmit']) {
      const response = await postHookEvent(
        server,
        buildBody(
          { hook_event_name: event, session_id: 'session-a', source: 'startup', prompt: 'task' },
          { agentProcess }
        )
      )
      expect(response.status).toBe(204)
    }
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
    probe.mockReset()
  })

  const settle = () => new Promise((resolve) => setImmediate(resolve))

  it('reports the agent exited once its process is gone', async () => {
    probe.mockResolvedValue('exited')
    server.retireProcessAuthority(PANE, { confirmedExit: true })
    await settle()
    expect(exits).toEqual([PANE])
  })

  it('keeps a stopped agent (Ctrl-Z) alive, and reports it when a later mark finds it gone', async () => {
    // A stopped process reads as unverifiable.
    probe.mockResolvedValue('unverifiable')
    server.retireProcessAuthority(PANE, { confirmedExit: true })
    await settle()
    expect(exits).toEqual([])

    probe.mockResolvedValue('exited')
    server.retireProcessAuthority(PANE, { launchRetired: true })
    await settle()
    expect(exits).toEqual([PANE])
  })

  it("reports an agent's own end hook", async () => {
    const response = await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'SessionEnd', session_id: 'session-a', reason: 'prompt_input_exit' },
        {
          agentProcess: JSON.stringify({
            pid: 4001,
            platform: process.platform,
            startTime: 'birth-4001'
          })
        }
      )
    )
    expect(response.status).toBe(204)
    await settle()
    expect(exits).toEqual([PANE])
  })

  it('reports nothing for a mark no host can prove, which may be a Ctrl-Z', async () => {
    const wslPane = 'tab-wsl:44444444-4444-4444-8444-444444444444'
    server.ingestRemote(
      {
        paneKey: wslPane,
        tabId: 'tab-wsl',
        worktreeId: String.raw`repo::\\wsl.localhost\Ubuntu\home\user\repo`,
        providerSession: { key: 'session_id', id: 'wsl-claude' },
        agentPresence: {
          agent: 'claude',
          sessionOwner: true,
          process: { pid: 4002, platform: 'linux', startTime: 'boot:4002' }
        },
        payload: { state: 'working', prompt: 'ship it', agentType: 'claude' }
      },
      wslHookRelayConnectionId('Ubuntu')
    )
    server.retireProcessAuthority(wslPane, { confirmedExit: true })
    await settle()
    expect(exits).toEqual([])
  })
})

describe("a command mark in a local agent's pane that reported no process", () => {
  it.each([
    [true, [PANE]],
    [null, []]
  ])('reports the exit only when the shell is proven alone (%s)', async (alone, expected) => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-marked-exit-'))
    const server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath })
      const exits: string[] = []
      server.setTerminalPaneLifecycle({
        ownsProcess: () => true,
        isStopping: () => false,
        isReversibleStop: () => false,
        isPlaced: () => true,
        confirmShellAlone: async () => alone,
        agentExited: (paneKey) => exits.push(paneKey)
      })
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: 'UserPromptSubmit', session_id: 'session-b', prompt: 'task' })
      )
      expect(response.status).toBe(204)
      server.retireProcessAuthority(PANE, { confirmedExit: true, launchRetired: true })
      await new Promise((resolve) => setImmediate(resolve))
      expect(exits).toEqual(expected)
    } finally {
      server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
