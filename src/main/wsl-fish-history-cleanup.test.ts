import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWslFishHistoryCleanups,
  deleteWslFishHistoryFile,
  flushWslFishHistoryCleanups
} from './wsl-fish-history-cleanup'

const okResult = { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false }

// Why reset on BOTH sides: the cleanup queue is module state, so one test's
// pending work would otherwise serialize behind — or deadlock — the next.
beforeEach(() => {
  __resetWslFishHistoryCleanups()
})

afterEach(async () => {
  await flushWslFishHistoryCleanups()
  __resetWslFishHistoryCleanups()
})

describe('deleteWslFishHistoryFile', () => {
  it('uses direct argv and bounds a distro cleanup subprocess', async () => {
    const run = vi.fn().mockResolvedValue(okResult)

    await deleteWslFishHistoryFile('Ubuntu Test', 'orca_0123456789abcdef', run)

    expect(run).toHaveBeenCalledWith({
      distro: 'Ubuntu Test',
      lane: 'probe',
      allowDegradedEnvironment: true,
      program: 'fish',
      args: ['--command', expect.stringContaining('orca_0123456789abcdef_history')],
      timeoutMs: 5_000
    })
  })

  it('rejects an unsafe session before spawning', async () => {
    const run = vi.fn()

    await deleteWslFishHistoryFile('Ubuntu', '../../user-history', run)

    expect(run).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests for the same distro and session', async () => {
    // Why: the GC sweep and an explicit worktree delete can queue the same
    // tombstone, and one wsl.exe launch per cleanup is enough.
    let settle!: () => void
    const run = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(okResult)
      })
    )
    const session = 'orca_0123456789abcdef'

    const first = deleteWslFishHistoryFile('Ubuntu', session, run)
    const second = deleteWslFishHistoryFile('Ubuntu', session, run)

    expect(second).toBe(first)
    expect(run).toHaveBeenCalledTimes(1)
    settle()
    await Promise.all([first, second])
  })

  it('keeps distinct distros independent of each other', async () => {
    const run = vi.fn().mockResolvedValue(okResult)

    await Promise.all([
      deleteWslFishHistoryFile('Ubuntu', 'orca_0123456789abcdef', run),
      deleteWslFishHistoryFile('Debian', 'orca_0123456789abcdef', run)
    ])

    expect(run).toHaveBeenCalledTimes(2)
  })

  it('permits a retry once a failed cleanup settles', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('distro offline')).mockResolvedValue(okResult)
    const session = 'orca_0123456789abcdef'

    await expect(deleteWslFishHistoryFile('Ubuntu', session, run)).rejects.toThrow('distro offline')
    await expect(deleteWslFishHistoryFile('Ubuntu', session, run)).resolves.toBeUndefined()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('treats a non-zero exit as a failed cleanup even though the runner resolved', async () => {
    const run = vi.fn().mockResolvedValue({ ...okResult, code: 1 })

    await expect(
      deleteWslFishHistoryFile('Ubuntu', 'orca_0123456789abcdef', run)
    ).rejects.toThrow('wsl fish history cleanup failed')
  })

  it('treats a runner timeout as a failed cleanup', async () => {
    const run = vi.fn().mockResolvedValue({ ...okResult, code: null, timedOut: true })

    await expect(
      deleteWslFishHistoryFile('Ubuntu', 'orca_0123456789abcdef', run)
    ).rejects.toThrow('wsl fish history cleanup failed')
  })
})
