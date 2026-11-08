import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetWslFishHistoryCleanups,
  deleteWslFishHistoryFile,
  flushWslFishHistoryCleanups
} from './wsl-fish-history-cleanup'

const okResult = { environmentResolved: true, code: 0, stdout: '', stderr: '', timedOut: false }
const running = async (): Promise<boolean> => true

beforeEach(() => {
  __resetWslFishHistoryCleanups()
})

afterEach(async () => {
  await flushWslFishHistoryCleanups()
  __resetWslFishHistoryCleanups()
})

describe('deleteWslFishHistoryFile', () => {
  it('rejects an unsafe session before spawning', async () => {
    const run = vi.fn()

    await deleteWslFishHistoryFile('Ubuntu', '../../user-history', run, running)

    expect(run).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests for the same distro and session', async () => {
    let settle!: () => void
    const run = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        settle = () => resolve(okResult)
      })
    )
    const session = 'orca_0123456789abcdef'

    const first = deleteWslFishHistoryFile('Ubuntu', session, run, running)
    const second = deleteWslFishHistoryFile('Ubuntu', session, run, running)

    expect(second).toBe(first)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    settle()
    await Promise.all([first, second])
  })

  it('permits a retry once a failed cleanup settles', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('distro offline'))
      .mockResolvedValue(okResult)
    const session = 'orca_0123456789abcdef'

    await expect(deleteWslFishHistoryFile('Ubuntu', session, run, running)).rejects.toThrow(
      'distro offline'
    )
    await expect(deleteWslFishHistoryFile('Ubuntu', session, run, running)).resolves.toBe('deleted')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not spawn into a stopped distro and reports it for a later retry', async () => {
    const run = vi.fn().mockResolvedValue(okResult)

    await expect(
      deleteWslFishHistoryFile('Ubuntu', 'orca_0123456789abcdef', run, async () => false)
    ).resolves.toBe('distro-stopped')
    expect(run).not.toHaveBeenCalled()
  })
})
