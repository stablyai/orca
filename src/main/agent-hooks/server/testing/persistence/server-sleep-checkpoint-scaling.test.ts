import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'
import { holdSavedStatusLock, readSavedStatus } from './last-status.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([
  [750, 100, 1],
  [7500, 100, 2],
  [750, 1000, 2],
  [7500, 1000, 1]
])(
  'checkpoints changed owners without serializing %i sleeping or %i active neighbors at %i updates/s',
  async (sleepers, active, rate) => {
    vi.useFakeTimers()
    const home = mkdtempSync(join(tmpdir(), 'orca-sleep-checkpoint-'))
    const path = join(home, 'agent-hooks', 'last-status.json')
    mkdirSync(join(home, 'agent-hooks'))
    const entries: Record<string, unknown> = {}
    for (let i = 0; i < sleepers + active; i++) {
      const paneKey = i === sleepers ? PANE : `fleet-${i}:11111111-1111-4111-8111-111111111111`
      entries[paneKey] = {
        paneKey,
        connectionId: null,
        worktreeId: 'wt-1',
        receivedAt: Date.now(),
        stateStartedAt: Date.now(),
        payload: {
          state: i < sleepers ? 'done' : 'working',
          prompt: 'Before',
          agentType: 'unknown'
        },
        ...(i < sleepers
          ? { paneSleep: { ptyId: `pty-${i}` }, agentPresence: { agent: 'unknown', ended: true } }
          : {})
      }
    }
    writeFileSync(path, JSON.stringify({ version: 2, entries }))
    const server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath: home })
      expect(server.getStatusSnapshot()).toHaveLength(sleepers + active)
      const stringify = vi.spyOn(JSON, 'stringify')
      for (let tick = 0; tick < 180 * rate; tick++) {
        server.ingestTerminalStatus({
          paneKey: PANE,
          connectionId: null,
          worktreeId: 'wt-1',
          payload: { state: 'working', prompt: `Update ${tick}`, agentType: 'unknown' }
        })
        await vi.advanceTimersByTimeAsync(1000 / rate)
      }
      server.flushStatusPersistSync()
      const slept = stringify.mock.calls.filter(
        ([value]) => value && typeof value === 'object' && 'paneSleep' in value
      )
      const rows = stringify.mock.calls.filter(
        ([value]) => value && typeof value === 'object' && 'payload' in value
      )
      expect(slept).toHaveLength(0)
      expect(rows.length).toBeLessThanOrEqual(2)
      stringify.mockRestore()
      expect(JSON.parse(readSavedStatus(path)).entries[PANE].payload.prompt).toBe(
        rate === 1 ? 'Update 179' : 'Update 359'
      )
      const release = holdSavedStatusLock(path)
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: null,
        worktreeId: 'wt-1',
        payload: { state: 'done', prompt: 'Saved after retry', agentType: 'unknown' }
      })
      expect(server.flushStatusPersistSync()).toBe(false)
      release()
      await vi.advanceTimersByTimeAsync(2000)
      expect(JSON.parse(readSavedStatus(path)).entries[PANE].payload.prompt).toBe(
        'Saved after retry'
      )
    } finally {
      server.stop()
      rmSync(home, { recursive: true, force: true })
    }
  }
)
