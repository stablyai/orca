import * as path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

import { resolveGitDir } from './resolve-git-dir'

// Expectations go through `path` so they hold on whichever host runs the suite.
const linkedGitDir = path.resolve('/repo/feature', '../main/.git/worktrees/feature')
const ownDotGit = path.join('/repo/feature', '.git')

describe('resolveGitDir', () => {
  beforeEach(() => {
    readFileMock.mockReset()
  })

  it('resolves a relative linked-worktree marker', async () => {
    readFileMock.mockResolvedValue('gitdir: ../main/.git/worktrees/feature\n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBe(linkedGitDir)
  })

  it('drops padding around the marker payload', async () => {
    readFileMock.mockResolvedValue('gitdir: ../main/.git/worktrees/feature  \r\n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBe(linkedGitDir)
  })

  it('does not treat a whitespace-only gitdir payload as a metadata directory', async () => {
    readFileMock.mockResolvedValue('gitdir:   \n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBe(ownDotGit)
  })

  it('ignores a gitdir line that is not the first line of the marker file', async () => {
    readFileMock.mockResolvedValue('[core]\ngitdir: ../main/.git/worktrees/feature\n')

    await expect(resolveGitDir('/repo/feature')).resolves.toBe(ownDotGit)
  })

  it('uses the .git directory when the marker cannot be read', async () => {
    readFileMock.mockRejectedValue(Object.assign(new Error('EISDIR'), { code: 'EISDIR' }))

    await expect(resolveGitDir('/repo/feature')).resolves.toBe(ownDotGit)
  })
})
