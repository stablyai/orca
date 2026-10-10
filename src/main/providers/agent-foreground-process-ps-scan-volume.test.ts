// Regression guard for issue #6288 (CPU half): bound the volume of full
// process-table `ps` scans driven by agent foreground-process inspection.
//
// Drives the REAL local call site (`resolveAgentForegroundProcess`) under the
// documented agent-completion cadence (ACTIVE_POLL_INTERVAL_MS = 750ms in
// agent-completion-coordinator.ts) across several concurrently-inspecting agent
// panes, and counts how many full process-table scans actually
// spawn. Pre-fix the call site forked one `ps` per pane per tick; with the
// shared snapshot cache the scans collapse to ~one per tick regardless of pane
// count, while each pane still resolves the same foreground identity.
import type * as FsPromises from 'node:fs/promises'
import type * as DarwinTerminalNames from '../../shared/darwin-terminal-names'
import type * as FullReader from '../../shared/process-table-snapshot-reader'
import {
  createProcessTablePsFixture,
  type PsFixtureRow
} from '../../shared/process-table-ps-test-fixture'
import type * as Foreground from './agent-foreground-process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, psScanCount } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  psScanCount: { value: 0 }
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))

// Inject /dev data without bypassing the production translator.
vi.mock('../../shared/darwin-terminal-names', async (importOriginal) => {
  const original = await importOriginal<typeof DarwinTerminalNames>()
  return {
    nameDarwinTerminals: (stdout: string, _deps: unknown, signal?: AbortSignal) =>
      psFixture.nameTerminals(original.nameDarwinTerminals, stdout, signal)
  }
})

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  readFile: async (path: string) => readProcStatMock(path)
}))

let fullReader: typeof FullReader
let foreground: typeof Foreground

const ACTIVE_POLL_INTERVAL_MS = 750 // mirrors agent-completion-coordinator.ts
const PANE_COUNT = 6 // reporter saw it with "only three projects" -> several agent panes
const WINDOW_SECONDS = 30
const TICKS = Math.floor((WINDOW_SECONDS * 1000) / ACTIVE_POLL_INTERVAL_MS)

const shellPid = (pane: number): number => 100 + pane * 1000

// A real `ps` returns the whole system, so one shared snapshot must contain
// every pane's shell + foreground codex child. Each pane resolves its own
// agent from the single scan.
function processRows(): PsFixtureRow[] {
  return Array.from({ length: PANE_COUNT }, (_, pane) => {
    const shell = shellPid(pane)
    const agent = shell + 1
    const base = { terminalMinor: pane, startTime: 'Thu Sep  3 16:02:01 2026', startTicks: 1_000 }
    return [
      { ...base, pid: shell, ppid: 99, pgid: shell, tpgid: agent, stat: 'Ss', command: 'bash -i' },
      {
        ...base,
        pid: agent,
        ppid: shell,
        pgid: agent,
        tpgid: agent,
        stat: 'S+',
        command: 'node /Users/dev/.nvm/versions/node/bin/codex'
      }
    ]
  }).flat()
}
const psFixture = createProcessTablePsFixture(processRows)
const readProcStatMock = vi.fn((path: string) => psFixture.readProcStat(path))

function installCountingPsMock(): void {
  execFileMock.mockImplementation(
    (
      cmd: string,
      args: string[],
      _opts: unknown,
      callback: (err: unknown, result: { stdout: string; stderr: string }) => void
    ) => {
      expect(cmd).toBe('ps')
      expect(args[0]).toBe('-axo')
      expect(args[1]).toBe(
        process.platform === 'darwin'
          ? 'pid=,ppid=,pgid=,tpgid=,stat=,tdev=,lstart=,command='
          : 'pid=,ppid=,pgid=,tpgid=,stat=,tty=,etimes=,command='
      )
      psScanCount.value += 1
      callback(null, { stdout: psFixture.render(args[1]), stderr: '' })
    }
  )
}

describe.each(['darwin', 'linux'])('#6288 foreground ps scan volume (%s)', (hostPlatform) => {
  let platform: PropertyDescriptor | undefined

  beforeEach(async () => {
    execFileMock.mockReset()
    readProcStatMock.mockClear()
    psScanCount.value = 0
    platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
    // Column constants are chosen at import time, so each host needs a fresh module graph.
    vi.resetModules()
    fullReader = await import('../../shared/process-table-snapshot-reader')
    fullReader.resetProcessTableSnapshotForTests()
    foreground = await import('./agent-foreground-process')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (hostPlatform === 'darwin') {
      expect(readProcStatMock).not.toHaveBeenCalled()
    } else {
      expect(readProcStatMock).toHaveBeenCalled()
    }
    // Production catches read errors; assert each path resolved against the fixture at read time.
    for (const [index, result] of readProcStatMock.mock.results.entries()) {
      expect(result.type, readProcStatMock.mock.calls[index][0]).toBe('return')
    }
  })

  it('bounds ps scans by poll ticks, not by pane count, while resolving every pane', async () => {
    installCountingPsMock()

    for (let tick = 0; tick < TICKS; tick++) {
      vi.setSystemTime(tick * ACTIVE_POLL_INTERVAL_MS)
      // All panes inspect concurrently within the tick (worst case for a busy relay).
      const resolved = await Promise.all(
        Array.from({ length: PANE_COUNT }, (_, pane) =>
          foreground.resolveAgentForegroundProcess(shellPid(pane), 'node')
        )
      )
      // Caching must not change the answer: every pane still resolves the agent.
      expect(resolved.every((name) => name === 'codex')).toBe(true)
    }

    const totalInspections = PANE_COUNT * TICKS
    // Pre-fix this equals totalInspections (one scan per inspection). With the
    // shared cache, concurrent panes within a tick share one scan and the 500ms
    // TTL forces a fresh scan each new 750ms tick -> ~one scan per tick.
    expect(psScanCount.value).toBe(TICKS)
    expect(psScanCount.value).toBeLessThan(totalInspections / 2)
  })
})
