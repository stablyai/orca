import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

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
})
