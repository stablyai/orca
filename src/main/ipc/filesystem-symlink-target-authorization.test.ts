import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { lstatMock, realpathMock, realpathSyncMock } = vi.hoisted(() => ({
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  realpathSyncMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  realpath: realpathMock
}))

vi.mock('node:fs', () => ({
  realpathSync: realpathSyncMock
}))

import { isPathAllowed } from './filesystem-auth'
import { authorizeSymlinkTargetPath } from './filesystem-symlink-target-authorization'

const REPO_PATH = path.resolve('/workspace/repo')
const LINK_PATH = path.join(REPO_PATH, 'linked-docs')
const TARGET_PATH = path.resolve('/elsewhere/docs')

const store = {
  getRepos: () => [
    { id: 'repo-1', path: REPO_PATH, displayName: 'repo', badgeColor: '#000', addedAt: 0 }
  ],
  getSettings: () => ({})
} as never

describe('authorizeSymlinkTargetPath', () => {
  beforeEach(() => {
    lstatMock.mockReset()
    realpathMock.mockReset().mockImplementation(async (target: string) => target)
    realpathSyncMock.mockReset().mockImplementation((target: string) => target)
  })

  it('authorizes a link target outside the workspace so its subtree becomes readable', async () => {
    lstatMock.mockResolvedValue({ isSymbolicLink: () => true })
    realpathMock.mockImplementation(async (target: string) =>
      target === LINK_PATH ? TARGET_PATH : target
    )

    expect(isPathAllowed(TARGET_PATH, store)).toBe(false)

    await expect(authorizeSymlinkTargetPath(LINK_PATH, store)).resolves.toBe(TARGET_PATH)

    expect(isPathAllowed(TARGET_PATH, store)).toBe(true)
    expect(isPathAllowed(path.join(TARGET_PATH, 'guide', 'index.md'), store)).toBe(true)
  })

  it('authorizes nothing when the path is a regular directory', async () => {
    const plainDirPath = path.join(REPO_PATH, 'src')
    lstatMock.mockResolvedValue({ isSymbolicLink: () => false })

    await expect(authorizeSymlinkTargetPath(plainDirPath, store)).resolves.toBeNull()

    expect(realpathSyncMock).not.toHaveBeenCalled()
  })

  it('refuses to follow a link that lives outside the allowed roots', async () => {
    const outsideLinkPath = path.resolve('/somewhere-else/linked-docs')
    lstatMock.mockResolvedValue({ isSymbolicLink: () => true })

    await expect(authorizeSymlinkTargetPath(outsideLinkPath, store)).rejects.toThrow(
      'Access denied'
    )

    expect(lstatMock).not.toHaveBeenCalled()
    expect(isPathAllowed(path.resolve('/somewhere-else'), store)).toBe(false)
  })
})
