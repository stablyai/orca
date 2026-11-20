import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProcessIndex, type ProcRow } from '../../memory/process-index'

const enumerateHostProcesses = vi.fn()
vi.mock('../../memory/host-process-index', () => ({
  enumerateHostProcesses: () => enumerateHostProcesses(),
  readExecutableNames: async () => {}
}))
vi.mock('../../memory/local-daemon-pid', () => ({ getKnownLocalDaemonPid: () => 50 }))

import { registerPty, unregisterPty } from '../../memory/pty-registry'
import {
  notePreGoneHostMemorySample,
  preGonePtyTreeMemoryDetails,
  resetPreGonePtyTreeMemoryForTest
} from './pre-gone-pty-tree-memory'

const MB = 1024 * 1024
const row = (pid: number, ppid: number, name: string, ws: number, commit: number): ProcRow => ({
  pid,
  ppid,
  cpu: 0,
  memory: ws * MB,
  privateMemory: commit * MB,
  name,
  // Parents start before children, as Windows creation times prove.
  startTicks: BigInt(pid)
})

// 32 GB commit limit: pressure starts below min(4096, 20%) = 4096 MB.
const healthy = { systemMemorySwapTotalMB: 32_768, systemMemorySwapFreeMB: 12_000 }
const commitFree = (mb: number) => ({
  systemMemorySwapTotalMB: 32_768,
  systemMemorySwapFreeMB: mb
})

describe('pre-gone PTY tree memory', () => {
  beforeEach(() => {
    resetPreGonePtyTreeMemoryForTest()
    enumerateHostProcesses.mockReset()
    enumerateHostProcesses.mockResolvedValue(
      buildProcessIndex(
        [
          row(50, 1, 'orca-daemon', 120, 150),
          row(100, 50, 'pwsh', 40, 30),
          row(101, 100, 'claude', 900, 6_000),
          row(102, 101, 'node', 300, 1_200),
          row(200, 50, 'cmd', 5, 4),
          row(300, 50, 'conhost', 12, 20),
          // A PTY the registry has no PID for.
          row(400, 50, 'codex', 700, 2_000),
          row(999, 1, 'chrome', 2_000, 9_000)
        ],
        null,
        'working-set'
      )
    )
    registerPty({ ptyId: 'a', worktreeId: 'w', sessionId: 'a', paneKey: null, pid: 100 })
    registerPty({ ptyId: 'b', worktreeId: 'w', sessionId: 'b', paneKey: null, pid: 200 })
    registerPty({ ptyId: 'c', worktreeId: 'w', sessionId: 'c', paneKey: null, pid: null })
  })

  afterEach(() => {
    unregisterPty('a')
    unregisterPty('b')
    unregisterPty('c')
  })

  const runTicks = async (freeMBAt: (tick: number) => number, ticks: number) => {
    for (let tick = 0; tick < ticks; tick += 1) {
      notePreGoneHostMemorySample(commitFree(freeMBAt(tick)), tick * 10_000, 'win32', tick * 10_000)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  it('caps sweeps per hour when headroom swings across the episode boundary', async () => {
    // 4,000 MB opens an episode and 4,700 MB ends it, every 20 s for an hour.
    await runTicks((tick) => (tick % 2 === 0 ? 4_000 : 4_700), 360)
    // A burst of 4 (0, 40, 80, 120 s), then one per 5-minute token (300 ... 3,300 s).
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(15)
  })

  it('probes a sweep that keeps failing every 30 minutes after three failures', async () => {
    enumerateHostProcesses.mockRejectedValue(new Error('CIM blocked'))
    await runTicks(() => 900, 720)
    // 0, 30, 60 s, then 1,860, 3,660 and 5,460 s over two hours.
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(6)
    expect(preGonePtyTreeMemoryDetails(0)).toEqual({})
  })

  it('never sweeps processes while the host has headroom', () => {
    for (let tick = 0; tick < 360; tick += 1) {
      notePreGoneHostMemorySample(healthy, tick * 10_000, 'win32', tick * 10_000)
    }
    expect(enumerateHostProcesses).not.toHaveBeenCalled()
    expect(preGonePtyTreeMemoryDetails(0)).toEqual({})
  })

  it('sweeps once per pressure episode, then only at new lows', async () => {
    let atMs = 0
    const tick = async (freeMB: number) => {
      notePreGoneHostMemorySample(commitFree(freeMB), atMs, 'win32', atMs)
      atMs += 10_000
      await new Promise((resolve) => setImmediate(resolve))
    }
    // An hour on a 900 MB plateau, with a sawtooth back up to 1,500 MB: one sweep.
    for (let i = 0; i < 360; i += 1) {
      await tick(i % 6 === 3 ? 1_500 : 900)
    }
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(1)
    // A new low of at least min(512 MB, 25%) sweeps again.
    await tick(650)
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(2)
    // Hovering just above the threshold stays in the same episode.
    await tick(4_200)
    await tick(800)
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(2)
    // Recovery ends the episode, so the next slide sweeps even from higher headroom.
    await tick(12_000)
    await tick(2_000)
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(3)
    const sweptAtMs = atMs - 10_000
    expect(preGonePtyTreeMemoryDetails(sweptAtMs + 5_000)).toEqual({
      ptyTreeMemoryPreGoneSampleAgeMs: 5_000,
      ptyTreeMemoryPreGonePtyCount: 2,
      ptyTreeMemoryPreGoneProcessCount: 4,
      ptyTreeMemoryPreGoneMemoryMetric: 'working-set',
      ptyTreeMemoryPreGoneMemoryMB: 1_245,
      ptyTreeMemoryPreGoneCommitMB: 7_234,
      ptyTreeMemoryPreGoneDaemonMemoryMB: 120,
      ptyTreeMemoryPreGoneDaemonCommitMB: 150,
      ptyTreeMemoryPreGoneUnattributedMemoryMB: 712,
      ptyTreeMemoryPreGoneUnattributedCommitMB: 2_020,
      ptyTreeMemoryPreGoneTop1Name: 'claude',
      ptyTreeMemoryPreGoneTop1MemoryMB: 900,
      ptyTreeMemoryPreGoneTop1CommitMB: 6_000,
      ptyTreeMemoryPreGoneTop2Name: 'node',
      ptyTreeMemoryPreGoneTop2MemoryMB: 300,
      ptyTreeMemoryPreGoneTop2CommitMB: 1_200,
      ptyTreeMemoryPreGoneTop3Name: 'pwsh',
      ptyTreeMemoryPreGoneTop3MemoryMB: 40,
      ptyTreeMemoryPreGoneTop3CommitMB: 30
    })
  })
})
