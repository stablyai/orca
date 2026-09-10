import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./runner', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetCanonicalRepoKeyCacheForTests,
  getCanonicalRepoKey,
  readGitCommonDir
} from './canonical-repo-key'

beforeEach(() => {
  _resetCanonicalRepoKeyCacheForTests()
  gitExecFileAsyncMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readGitCommonDir', () => {
  it('reads the absolute answer modern Git gives', () => {
    expect(readGitCommonDir('/repo/.git\n', '/repo/worktrees/a')).toBe('/repo/.git')
  })

  it('drops the flag Git older than 2.31 echoes back, and resolves the relative answer', () => {
    // Without this every repository on such a host would answer `.git` and collide.
    expect(readGitCommonDir('--path-format=absolute\n.git\n', '/repo')).toBe('/repo/.git')
  })

  it('resolves a WSL answer in Git execution space, not against the UNC path', () => {
    expect(readGitCommonDir('.git\n', '//wsl$/Ubuntu/home/dev/repo')).toBe('/home/dev/repo/.git')
  })

  it('tolerates CRLF and blank lines', () => {
    expect(readGitCommonDir('\r\n/repo/.git\r\n', '/repo')).toBe('/repo/.git')
  })

  it('returns undefined when Git printed nothing usable', () => {
    expect(readGitCommonDir('\n', '/repo')).toBeUndefined()
  })
})

describe('getCanonicalRepoKey', () => {
  it('gives every worktree of one repository the same key', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/repo/.git\n', stderr: '' })

    await expect(getCanonicalRepoKey('/repo')).resolves.toBe('local::/repo/.git')
    await expect(getCanonicalRepoKey('/repo/worktrees/a')).resolves.toBe('local::/repo/.git')
  })

  it('scopes the key to the execution host', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/home/dev/repo/.git\n', stderr: '' })

    await expect(
      getCanonicalRepoKey('//wsl$/Ubuntu/home/dev/repo', { wslDistro: 'Ubuntu' })
    ).resolves.toBe('wsl:Ubuntu::/home/dev/repo/.git')
  })

  it('caches so repeated arming costs no subprocess', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/repo/.git\n', stderr: '' })

    await getCanonicalRepoKey('/repo')
    await getCanonicalRepoKey('/repo')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the caller path when Git cannot answer', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('not a git repository'))

    await expect(getCanonicalRepoKey('/not-a-repo')).resolves.toBe('local::/not-a-repo')
  })
})
