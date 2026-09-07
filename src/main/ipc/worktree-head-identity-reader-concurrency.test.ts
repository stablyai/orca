import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock, readdirMock, concurrency } = vi.hoisted(() => ({
  readFileMock: vi.fn(),
  readdirMock: vi.fn(),
  concurrency: { active: 0, max: 0 }
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  readdir: readdirMock
}))

import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'

const WORKTREE_COUNT = 16

describe('readGitCommonHeadIdentities concurrency', () => {
  beforeEach(() => {
    readFileMock.mockReset()
    readdirMock.mockReset()
    concurrency.active = 0
    concurrency.max = 0
    readdirMock.mockResolvedValue(
      Array.from({ length: WORKTREE_COUNT }, (_, index) => ({
        name: `wt-${index}`,
        isDirectory: () => true
      }))
    )
    readFileMock.mockImplementation(async (filePath: string) => {
      concurrency.active += 1
      concurrency.max = Math.max(concurrency.max, concurrency.active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      concurrency.active -= 1
      if (filePath.endsWith('/gitdir')) {
        return `/workspace/${filePath.match(/wt-\d+/)?.[0] ?? 'wt'}/.git\n`
      }
      return `${'a'.repeat(40)}\n`
    })
  })

  it('overlaps linked-worktree metadata reads while preserving listing order', async () => {
    const { identities } = await readGitCommonHeadIdentities('/repo/common')

    expect(identities).toHaveLength(WORKTREE_COUNT)
    expect(identities.map((identity) => identity.worktreePath)).toEqual(
      Array.from({ length: WORKTREE_COUNT }, (_, index) => `/workspace/wt-${index}`)
    )
    // The bounded worker pool should overlap independent reads without launching
    // an unbounded promise fan-out.
    expect(concurrency.max).toBeGreaterThan(1)
    expect(concurrency.max).toBeLessThanOrEqual(8)
  })
})
