import { describe, expect, it, vi } from 'vitest'

// Windows answers a mapped drive's real path with its share, as its native realpath does.
vi.mock('node:fs/promises', () => ({
  realpath: vi.fn(async (path: string) => path.replace(/^W:/i, '\\\\wsl.localhost\\Ubuntu'))
}))

import { findProjectAtSameRealPath } from './project-realpath-identity'

describe('findProjectAtSameRealPath', () => {
  it('finds a project saved on a distro-mapped drive from its share spelling', async () => {
    const saved = { id: 'repo-w', path: 'W:\\home\\u\\repo' }
    await expect(
      findProjectAtSameRealPath([saved], '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo')
    ).resolves.toBe(saved)
  })
})
