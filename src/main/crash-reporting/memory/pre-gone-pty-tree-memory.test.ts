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
const lowCommit = { systemMemorySwapTotalMB: 32_768, systemMemorySwapFreeMB: 900 }

describe('pre-gone PTY tree memory', () => {
  beforeEach(() => {
    resetPreGonePtyTreeMemoryForTest()
    enumerateHostProcesses.mockReset()
    enumerateHostProcesses.mockResolvedValue(
      buildProcessIndex(
        [
          row(50, 1, 'orca-daemon.exe', 120, 150),
          row(100, 50, 'pwsh.exe', 40, 30),
          row(101, 100, 'claude.exe', 900, 6_000),
          row(102, 101, 'node.exe', 300, 1_200),
          row(200, 50, 'cmd.exe', 5, 4),
          row(999, 1, 'chrome.exe', 2_000, 9_000)
        ],
        null,
        'working-set'
      )
    )
    registerPty({ ptyId: 'a', worktreeId: 'w', sessionId: 'a', paneKey: null, pid: 100 })
    registerPty({ ptyId: 'b', worktreeId: 'w', sessionId: 'b', paneKey: null, pid: 200 })
  })

  afterEach(() => {
    unregisterPty('a')
    unregisterPty('b')
  })

  it('never sweeps processes while the host has headroom', () => {
    for (let tick = 0; tick < 360; tick += 1) {
      notePreGoneHostMemorySample(healthy, tick * 10_000, 'win32')
    }
    expect(enumerateHostProcesses).not.toHaveBeenCalled()
    expect(preGonePtyTreeMemoryDetails(0)).toEqual({})
  })

  it('sweeps at most every 30 s under pressure and reports the PTY tree', async () => {
    for (let tick = 0; tick < 7; tick += 1) {
      notePreGoneHostMemorySample(lowCommit, tick * 10_000, 'win32')
      await new Promise((resolve) => setImmediate(resolve))
    }
    // Ticks at 0, 30 s and 60 s.
    expect(enumerateHostProcesses).toHaveBeenCalledTimes(3)
    expect(preGonePtyTreeMemoryDetails(65_000)).toEqual({
      ptyTreeMemoryPreGoneSampleAgeMs: 5_000,
      ptyTreeMemoryPreGonePtyCount: 2,
      ptyTreeMemoryPreGoneProcessCount: 4,
      ptyTreeMemoryPreGoneMemoryMetric: 'working-set',
      ptyTreeMemoryPreGoneMemoryMB: 1_245,
      ptyTreeMemoryPreGoneCommitMB: 7_234,
      ptyTreeMemoryPreGoneDaemonMemoryMB: 120,
      ptyTreeMemoryPreGoneDaemonCommitMB: 150,
      ptyTreeMemoryPreGoneTop1Name: 'claude.exe',
      ptyTreeMemoryPreGoneTop1MemoryMB: 900,
      ptyTreeMemoryPreGoneTop1CommitMB: 6_000,
      ptyTreeMemoryPreGoneTop2Name: 'node.exe',
      ptyTreeMemoryPreGoneTop2MemoryMB: 300,
      ptyTreeMemoryPreGoneTop2CommitMB: 1_200,
      ptyTreeMemoryPreGoneTop3Name: 'pwsh.exe',
      ptyTreeMemoryPreGoneTop3MemoryMB: 40,
      ptyTreeMemoryPreGoneTop3CommitMB: 30
    })
  })
})
