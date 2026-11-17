import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildProcessIndex, type ProcRow } from '../../memory/process-index'

const enumerateHostProcesses = vi.fn()
vi.mock('../../memory/host-process-index', () => ({
  enumerateHostProcesses: () => enumerateHostProcesses()
}))
vi.mock('../../memory/local-daemon-pid', () => ({ getLocalDaemonPid: () => 50 }))

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
  name
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

  it('never sweeps processes while the host has headroom', () => {
    for (let tick = 0; tick < 360; tick += 1) {
      notePreGoneHostMemorySample(healthy, tick * 10_000, 'win32')
    }
    expect(enumerateHostProcesses).not.toHaveBeenCalled()
    expect(preGonePtyTreeMemoryDetails(0)).toEqual({})
  })

  it('sweeps under pressure, then again only as headroom falls or every 5 min', async () => {
    const tick = async (atMs: number, freeMB: number) => {
      notePreGoneHostMemorySample(commitFree(freeMB), atMs, 'win32')
      await new Promise((resolve) => setImmediate(resolve))
    }
    // A steady 900 MB plateau for 4.5 min: one sweep.
    for (let atMs = 0; atMs < 270_000; atMs += 10_000) {
      await tick(atMs, 900)
    }
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(1)
    // Falling by at least min(512 MB, 25%) sweeps again; within 30 s it waits.
    await tick(270_000, 650)
    await tick(280_000, 300)
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(2)
    // Plateau again: next sweep 5 min after the last.
    for (let atMs = 290_000; atMs <= 570_000; atMs += 10_000) {
      await tick(atMs, 650)
    }
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(3)
    expect(preGonePtyTreeMemoryDetails(575_000)).toEqual({
      ptyTreeMemoryPreGoneSampleAgeMs: 5_000,
      ptyTreeMemoryPreGonePtyCount: 2,
      ptyTreeMemoryPreGoneProcessCount: 4,
      ptyTreeMemoryPreGoneMemoryMetric: 'working-set',
      ptyTreeMemoryPreGoneMemoryMB: 1_245,
      ptyTreeMemoryPreGoneCommitMB: 7_234,
      ptyTreeMemoryPreGoneDaemonMemoryMB: 132,
      ptyTreeMemoryPreGoneDaemonCommitMB: 170,
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
