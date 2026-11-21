import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, OLD_PANE, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: async () => 'unverifiable'
}))

const DAY_MS = 24 * 60 * 60 * 1000
const servers: AgentHookServer[] = []
let userDataPath: string | null = null

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  if (userDataPath) {
    rmSync(userDataPath, { recursive: true, force: true })
    userDataPath = null
  }
  vi.restoreAllMocks()
})

function bindPlacement(server: AgentHookServer): void {
  server.setTerminalPaneLifecycle({
    isPlaced: (row) => row.paneKey === PANE,
    ownsProcess: () => true,
    isStopping: () => false,
    isReversibleStop: () => false
  })
  server.pruneUnplacedPanes()
}

it("keeps a placed pane's Claude session through a restart after a week without hooks", async () => {
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-placed-pane-ttl-'))
  const first = new AgentHookServer()
  servers.push(first)
  await first.start({ env: 'production', userDataPath })
  bindPlacement(first)
  for (const [paneKey, tabId, session] of [
    [PANE, 'tab-1', 'placed-session'],
    [OLD_PANE, 'tab-old', 'closed-session']
  ] as const) {
    for (const hook_event_name of ['SessionStart', 'UserPromptSubmit']) {
      const response = await postHookEvent(
        first,
        buildBody(
          { hook_event_name, session_id: session, source: 'startup', prompt: 'task' },
          { paneKey, tabId }
        )
      )
      expect(response.status).toBe(204)
    }
  }
  first.flushStatusPersistSync()

  now += 8 * DAY_MS
  first.flushStatusPersistSync()
  first.stop()

  const restarted = new AgentHookServer()
  servers.push(restarted)
  await restarted.start({ env: 'production', userDataPath })
  bindPlacement(restarted)
  // The week-old working turn returns unverifiable, never as live work.
  expect(restarted.getStatusRowsForPaneOrHandle(PANE)).toEqual([
    expect.objectContaining({
      providerSession: expect.objectContaining({ id: 'placed-session' }),
      restoredUnconfirmed: true
    })
  ])
  expect(restarted.getStatusRowsForPaneOrHandle(OLD_PANE)).toEqual([])
})

it("keeps a placed pane's week-old agent exit, so its kept row does not read as live", async () => {
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-placed-pane-exit-'))
  const first = new AgentHookServer()
  servers.push(first)
  await first.start({ env: 'production', userDataPath })
  bindPlacement(first)
  const attachedAt = now - 1
  const agentProcess = JSON.stringify({ pid: 4001, platform: process.platform, startTime: 'b' })
  for (const [hook_event_name, reason] of [
    ['SessionStart', undefined],
    ['SessionEnd', 'prompt_input_exit']
  ] as const) {
    const response = await postHookEvent(
      first,
      buildBody(
        { hook_event_name, session_id: 'quit-session', source: 'startup', reason },
        { agentProcess }
      )
    )
    expect(response.status).toBe(204)
  }
  first.flushStatusPersistSync()

  now += 8 * DAY_MS
  first.flushStatusPersistSync()
  first.stop()

  const restarted = new AgentHookServer()
  servers.push(restarted)
  await restarted.start({ env: 'production', userDataPath })
  bindPlacement(restarted)
  expect(restarted.getStatusRowsForPaneOrHandle(PANE)[0]?.providerSession?.id).toBe('quit-session')
  expect(await restarted.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
})
