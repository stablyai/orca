import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { _resetCanonicalRepoKeyCacheForTests, readGitCommonDir } from './canonical-repo-key'

beforeEach(() => {
  _resetCanonicalRepoKeyCacheForTests()
  gitExecFileAsyncMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readGitCommonDir', () => {
  it('drops the flag Git older than 2.31 echoes back, and resolves the relative answer', () => {
    expect(readGitCommonDir('--path-format=absolute\n.git\n', '/repo')).toBe('/repo/.git')
  })

  it('resolves a WSL answer in Git execution space, not against the UNC path', () => {
    expect(readGitCommonDir('.git\n', '//wsl$/Ubuntu/home/dev/repo')).toBe('/home/dev/repo/.git')
  })
})
