import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getStatus } from './source-control/status-read'

const { lstat, stream, conflict } = vi.hoisted(() => ({
  lstat: vi.fn(),
  stream: vi.fn(),
  conflict: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ lstat }))
vi.mock('./source-control/git-conflict-operation', () => ({ detectConflictOperation: conflict }))
vi.mock('./runner', () => ({
  gitStreamStdout: stream,
  gitOptionalLocksDisabledEnv: () => ({ GIT_OPTIONAL_LOCKS: '0' })
}))

beforeEach(() => {
  vi.clearAllMocks()
  conflict.mockResolvedValue(undefined)
  lstat.mockResolvedValue({ isSymbolicLink: () => true })
  stream.mockImplementation(async (_args, options) => {
    options.onStdout('? unrelated.txt\n')
    return { stoppedEarly: false }
  })
})

function status(sharedLinkPaths: string[]) {
  return getStatus('/repo', { sharedLinkPaths, includeLineStats: false })
}

describe('status shared symlink probe budget', () => {
  it.each([1, 8, 32])(
    'does no unrelated symlink probes for %i configured paths over 100 refreshes',
    async (count) => {
      const paths = Array.from({ length: count }, (_, index) => `shared-${index}`)
      for (let refresh = 0; refresh < 100; refresh++) {
        expect((await status(paths)).entries).toEqual([
          { path: 'unrelated.txt', status: 'untracked', area: 'untracked' }
        ])
      }
      expect(lstat).not.toHaveBeenCalled()
      expect(stream).toHaveBeenCalledTimes(100)
    }
  )

  it('rechecks matching paths after the filesystem changes and preserves unreadable paths', async () => {
    const paths = ['unrelated.txt']
    expect((await status(paths)).entries).toEqual([])
    lstat.mockResolvedValueOnce({ isSymbolicLink: () => false })
    expect((await status(paths)).entries).toHaveLength(1)
    lstat.mockRejectedValueOnce(new Error('EACCES'))
    expect((await status(paths)).entries).toHaveLength(1)
    expect(lstat).toHaveBeenCalledTimes(3)
  })
})
