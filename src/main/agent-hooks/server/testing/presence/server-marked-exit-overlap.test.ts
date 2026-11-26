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

describe("overlapping command marks in a local agent's pane", () => {
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

  it('asks again for a mark that lands while the last one is still probing', async () => {
    let answerFirst: (verdict: 'unverifiable') => void = () => {}
    probe.mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
    server.retireProcessAuthority(PANE, { confirmedExit: true })
    // The agent exits; its shell's mark arrives before the first probe answers.
    probe.mockResolvedValue('exited')
    server.retireProcessAuthority(PANE, { launchRetired: true })
    answerFirst('unverifiable')
    await settle()
    await settle()
    expect(exits).toEqual([PANE])
  })
})
