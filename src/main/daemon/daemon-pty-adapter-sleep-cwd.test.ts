import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, realpathSync, rmSync } from 'node:fs'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonClient } from './client'
import type { DaemonServer } from './daemon-server'
import { getHistorySessionDirName } from './history-paths'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'
import type * as DaemonTccAttributionModule from './daemon-tcc-attribution'
import type * as ProcessCwdModule from '../providers/process-cwd'

const {
  getMacDaemonSystemResolverHealthMock,
  getMacDaemonTccAttributionHealthMock,
  resolveProcessCwdSpy
} = vi.hoisted(() => ({
  resolveProcessCwdSpy: vi.fn(),
  getMacDaemonSystemResolverHealthMock: vi.fn(
    async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
  ),
  getMacDaemonTccAttributionHealthMock: vi.fn(
    async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
  )
}))

vi.mock('../providers/process-cwd', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessCwdModule>()
  resolveProcessCwdSpy.mockImplementation(actual.resolveProcessCwd)
  return { ...actual, resolveProcessCwd: resolveProcessCwdSpy }
})

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock
  }
})

vi.mock('./daemon-tcc-attribution', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonTccAttributionModule>()
  return {
    ...actual,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
  }
})

// verify-15b: a WSL host's pane (orcad on Linux, bash, no OSC 7) woke in the project root after `cd deep`.
describe('a native shell slept and woken', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let spawnedCwds: (string | undefined)[]
  let lastSubprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    spawnedCwds = []
    const harness = await startDaemonAdapterHarness((opts) => {
      spawnedCwds.push(opts.cwd)
      // A real pid, so the daemon's cwd lookup reads this process's folder, as for a live shell.
      lastSubprocess = Object.assign(createMockSubprocess(), { pid: process.pid })
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  })

  afterEach(async () => {
    resolveProcessCwdSpy.mockClear()
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('wakes in the folder the shell was in at Sleep, not where it was spawned', async () => {
    const historyDir = join(dir, 'history')
    const sessionId = 'wt-1::/project@@sleep1'
    const shellFolder = realpathSync(process.cwd())
    const history = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

    await history.spawn({ cols: 80, rows: 24, cwd: dir, sessionId })
    lastSubprocess._simulateData('user@host:~/project$ cd deep\r\nuser@host:~/project/deep$ ')
    await history.shutdown(sessionId, { immediate: true, keepHistory: true })

    const saved = JSON.parse(
      readFileSync(join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json'), 'utf8')
    )
    expect(realpathSync(saved.cwd)).toBe(shellFolder)
    await history.spawn({ cols: 80, rows: 24, cwd: dir, sessionId })
    expect(realpathSync(spawnedCwds.at(-1)!)).toBe(shellFolder)
    history.dispose()
  })

  // The process lookup execFile()s lsof, which Windows lacks; Sleep there keeps only the OSC 7 cwd.
  it('on Windows, Sleep without OSC 7 never looks up the process', async () => {
    const realPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const historyDir = join(dir, 'history')
      const sessionId = 'wt-1::/project@@sleep-win'
      const history = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })

      await history.spawn({ cols: 80, rows: 24, cwd: dir, sessionId })
      lastSubprocess._simulateData('PS C:\\project> cd deep\r\nPS C:\\project\\deep> ')
      await history.shutdown(sessionId, { immediate: true, keepHistory: true })

      const saved = JSON.parse(
        readFileSync(
          join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json'),
          'utf8'
        )
      )
      expect(resolveProcessCwdSpy).not.toHaveBeenCalled()
      expect(saved.cwd).toBe(dir)
      history.dispose()
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
    }
  })

  async function sleepAndWake(sessionId: string, deadlineMs?: number) {
    const historyDir = join(dir, 'history')
    const history = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath: historyDir })
    await history.spawn({ cols: 80, rows: 24, cwd: dir, sessionId })
    lastSubprocess._simulateData('user@host:~/project$ ')
    await history.shutdown(sessionId, { immediate: true, keepHistory: true, deadlineMs })
    const saved = JSON.parse(
      readFileSync(join(historyDir, getHistorySessionDirName(sessionId), 'checkpoint.json'), 'utf8')
    )
    await history.spawn({ cols: 80, rows: 24, cwd: dir, sessionId })
    history.dispose()
    return { savedCwd: saved.cwd, wokeCwd: spawnedCwds.at(-1) }
  }

  it('wakes in the spawn folder when the shell folder was deleted', async () => {
    resolveProcessCwdSpy.mockResolvedValueOnce(`${dir}/deep (deleted)`)
    const { savedCwd, wokeCwd } = await sleepAndWake('wt-1::/project@@sleep-deleted')
    expect(resolveProcessCwdSpy).toHaveBeenCalled()
    expect(savedCwd).toBe(dir)
    expect(wokeCwd).toBe(dir)
  })

  it('wakes in the spawn folder when the shell folder is unreadable', async () => {
    resolveProcessCwdSpy.mockResolvedValueOnce('')
    const { savedCwd, wokeCwd } = await sleepAndWake('wt-1::/project@@sleep-unreadable')
    expect(resolveProcessCwdSpy).toHaveBeenCalled()
    expect(savedCwd).toBe(dir)
    expect(wokeCwd).toBe(dir)
  })

  it('gives a hung folder read a quarter of the Sleep deadline, then checkpoints', async () => {
    // Freeze only the clock, so the read's budget is exact while socket timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    const requestSpy = vi.spyOn(DaemonClient.prototype, 'request')
    try {
      const now = Date.now()
      resolveProcessCwdSpy.mockImplementationOnce(() => new Promise<string>(() => {}))
      const { savedCwd } = await sleepAndWake('wt-1::/project@@sleep-hung', now + 2_000)
      expect(resolveProcessCwdSpy).toHaveBeenCalled()
      const cwdTimeouts = requestSpy.mock.calls
        .filter(([type]) => type === 'getCwd')
        .map((c) => c[2])
      expect(cwdTimeouts).toEqual([500])
      expect(savedCwd).toBe(dir)
    } finally {
      requestSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
