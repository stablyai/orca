import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { GOOD_PANE, PANE } from '../server.test-fixtures'
import { readSavedStatus } from './last-status.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// A restart that skips the quit flush (crash, relaunch) restores a reattached agent's turn from
// these rows, so a turn edge must reach disk without waiting for the 3-minute batched save, and
// only the edged pane's row is written ahead of the batch.
describe('saved agent status between batched saves', () => {
  let userDataPath: string
  let server: AgentHookServer
  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const saved = (pane: string): { state?: string; prompt?: string } =>
    JSON.parse(readSavedStatus(lastStatusPath())).entries[pane]?.payload ?? {}
  const report = (pane: string, state: 'working' | 'done', prompt: string): void => {
    server.ingestTerminalStatus({ paneKey: pane, payload: { state, prompt, agentType: 'claude' } })
  }

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-turn-edge-persistence-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('saves a turn edge within a second, writing only that pane', () => {
    report(PANE, 'working', 'turn one')
    report(GOOD_PANE, 'working', 'other turn')
    vi.advanceTimersByTime(0)
    expect(saved(PANE).state).toBe('working')

    // A second edge inside the window waits for it, so a burst of edges shares one write.
    report(GOOD_PANE, 'working', 'other turn, newer text')
    report(PANE, 'done', 'turn one')
    vi.advanceTimersByTime(999)
    expect(saved(PANE).state).toBe('working')
    vi.advanceTimersByTime(1)
    expect(saved(PANE).state).toBe('done')
    // The other pane's same-turn update is left to the batch.
    expect(saved(GOOD_PANE).prompt).toBe('other turn')

    // An edge after a quiet spell saves at once.
    vi.advanceTimersByTime(10_000)
    report(PANE, 'working', 'turn two')
    vi.advanceTimersByTime(0)
    expect(saved(PANE)).toMatchObject({ state: 'working', prompt: 'turn two' })
  })

  it('still runs the batched save while turn edges keep arriving', () => {
    report(PANE, 'working', 'turn 0')
    report(GOOD_PANE, 'working', 'first')
    vi.advanceTimersByTime(0)
    report(GOOD_PANE, 'working', 'pending for the batch')
    for (let turn = 1; turn <= 200; turn++) {
      report(PANE, turn % 2 ? 'done' : 'working', `turn ${turn}`)
      vi.advanceTimersByTime(1_000)
    }
    expect(saved(GOOD_PANE).prompt).toBe('pending for the batch')
  })
})
