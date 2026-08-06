import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'

const {
  listFilesWithGitMock,
  resolveAuthorizedPathMock,
  checkRgAvailableMock,
  getLocalGitOptionsForRegisteredWorktreeMock
} = vi.hoisted(() => ({
  listFilesWithGitMock: vi.fn(),
  resolveAuthorizedPathMock: vi.fn(),
  checkRgAvailableMock: vi.fn(),
  getLocalGitOptionsForRegisteredWorktreeMock: vi.fn()
}))

vi.mock('./filesystem-list-files-git-fallback', () => ({
  listFilesWithGit: listFilesWithGitMock
}))

vi.mock('./filesystem-auth', () => ({
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('./rg-availability', () => ({
  checkRgAvailable: checkRgAvailableMock
}))

vi.mock('./local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: getLocalGitOptionsForRegisteredWorktreeMock
}))

import { listQuickOpenFiles } from './filesystem-list-files'

describe('filesystem-list-files ripgrep guidance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveAuthorizedPathMock.mockImplementation(async (path) => path)
    checkRgAvailableMock.mockResolvedValue(false)
    getLocalGitOptionsForRegisteredWorktreeMock.mockReturnValue({})
  })

  it('turns only a readdir budget failure into install guidance', async () => {
    listFilesWithGitMock.mockRejectedValue(new Error('File listing exceeded 10000 files'))
    const rejection = listQuickOpenFiles('/workspace', {} as Store)

    await expect(rejection).rejects.toThrow(
      'Quick Open scan too large (File listing exceeded 10000 files).'
    )
    await rejection.catch((error: Error) =>
      expect(error.message).toContain('Install ripgrep on the host running the Quick Open scan')
    )
  })

  it('keeps cancellation and Git errors unchanged', async () => {
    const cancellation = new Error('File listing cancelled')
    listFilesWithGitMock.mockRejectedValueOnce(cancellation)
    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toBe(cancellation)

    const gitFailure = new Error('git ls-files exited with code 128')
    listFilesWithGitMock.mockRejectedValueOnce(gitFailure)
    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toBe(gitFailure)
  })

  it.skipIf(process.platform !== 'darwin')('shows the macOS install command', async () => {
    listFilesWithGitMock.mockRejectedValue(new Error('File listing timed out'))

    await expect(listQuickOpenFiles('/workspace', {} as Store)).rejects.toThrow(
      'brew install ripgrep'
    )
  })
})
