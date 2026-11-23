import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import { readSavedStatus } from './last-status.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// A restart that skips the quit flush (crash, relaunch) restores a reattached agent's turn from
// these rows, so a turn edge must reach disk without waiting for the 3-minute batched save.
describe('saved agent status between batched saves', () => {
  let userDataPath: string
  let server: AgentHookServer
  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const saved = (): { state?: string; prompt?: string } =>
    JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE]?.payload ?? {}
  const report = (state: 'working' | 'done', prompt: string): void => {
    server.ingestTerminalStatus({ paneKey: PANE, payload: { state, prompt, agentType: 'claude' } })
  }

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-turn-edge-persistence-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('saves a turn edge within a second and leaves same-turn updates to the batched save', async () => {
    report('working', 'turn one')
    await vi.waitFor(() => expect(saved().state).toBe('working'), { timeout: 3000 })

    report('done', 'turn one')
    await vi.waitFor(() => expect(saved().state).toBe('done'), { timeout: 3000 })

    report('done', 'same turn, newer text')
    // Past the turn-edge window: only the batched save would write this.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(saved()).toMatchObject({ state: 'done', prompt: 'turn one' })
  })
})
