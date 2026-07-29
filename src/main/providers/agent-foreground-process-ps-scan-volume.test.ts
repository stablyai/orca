// Regression guard for issue #6288 (CPU half): bound the volume of full
// process-table `ps` scans driven by agent foreground-process inspection.
//
// Drives the REAL local call site (`resolveAgentForegroundProcess`) under the
// documented agent-completion cadence (ACTIVE_POLL_INTERVAL_MS = 750ms in
// agent-completion-coordinator.ts) across several concurrently-inspecting agent
// panes, and counts how many `ps -axo pid=,ppid=,stat=,command=` scans actually
// spawn. Pre-fix the call site forked one `ps` per pane per tick; with the
// shared snapshot cache the scans collapse to ~one per tick regardless of pane
// count, while each pane still resolves the same foreground identity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, psScanCount } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  psScanCount: { value: 0 }
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

import { resetProcessTableSnapshotForTests } from '../../shared/process-table-snapshot'
import { resolveAgentForegroundProcess } from './agent-foreground-process'

const ACTIVE_POLL_INTERVAL_MS = 750 // mirrors agent-completion-coordinator.ts
const PANE_COUNT = 6 // reporter saw it with "only three projects" -> several agent panes
const WINDOW_SECONDS = 30
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / ACTIVE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 100 + pane * 1000

// A real `ps` returns the whole system, so one shared snapshot must contain
// every pane's shell + foreground codex child. Each pane resolves its own
// agent from the single scan.
const PS_OUTPUT = Array.from({ length: PANE_COUNT }, (_, pane) => {
  const shell = shellPid(pane)
  return [
    `${shell} 99 Ss   bash -i`,
    `${shell + 1} ${shell} S+   node /Users/dev/.nvm/versions/node/bin/codex`
  ].join('\n')
}).join('\n')

function installCountingPsMock(): void {
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
    const callback = cb as (err: unknown, result: { stdout: string; stderr: string }) => void
    if (cmd === 'ps' && Array.isArray(args) && args.includes('-axo')) {
      psScanCount.value += 1
    }
    callback(null, { stdout: PS_OUTPUT, stderr: '' })
  })
}

describe('#6288 agent foreground inspection ps-scan volume', () => {
  let platform: PropertyDescriptor | undefined

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    psScanCount.value = 0
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('bounds ps scans by poll ticks, not by pane count, while resolving every pane', async () => {
    installCountingPsMock()

    for (let tick = 0; tick < TICKS; tick++) {
      vi.setSystemTime(tick * ACTIVE_POLL_INTERVAL_MS)
      // All panes inspect concurrently within the tick (worst case for a busy relay).
      const resolved = await Promise.all(
        Array.from({ length: PANE_COUNT }, (_, pane) =>
          resolveAgentForegroundProcess(shellPid(pane), 'node')
        )
      )
      // Caching must not change the answer: every pane still resolves the agent.
      expect(resolved.every((name) => name === 'codex')).toBe(true)
    }

    const totalInspections = PANE_COUNT * TICKS
    // Pre-fix this equals totalInspections (one scan per inspection). With the
    // shared cache, concurrent panes within a tick share one scan and the 500ms
    // TTL forces a fresh scan each new 750ms tick -> ~one scan per tick.
    expect(psScanCount.value).toBeLessThanOrEqual(TICKS + 1)
    expect(psScanCount.value).toBeLessThan(totalInspections / 2)
  })
})
