import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('./command-runner/git-exec-file', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetCanonicalRepoKeyCacheForTests,
  getCanonicalRepoKey,
  peekGitCommonDir,
  readGitCommonDir
} from './canonical-repo-key'

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
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

describe('getCanonicalRepoKey', () => {
  it('exposes only verified common-directory answers to diagnostics', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/repo/.git\n', stderr: '' })

    expect(peekGitCommonDir('/repo')).toBeUndefined()
    expect(await getCanonicalRepoKey('/repo')).toBe('local::/repo/.git')
    expect(peekGitCommonDir('/repo')).toBe('/repo/.git')
    gitExecFileAsyncMock.mockRejectedValue(new Error('not a repository'))
    expect(await getCanonicalRepoKey('/missing')).toBe('local::/missing')
    expect(peekGitCommonDir('/missing')).toBeUndefined()
  })

  it('leaves ambiguous Windows drive identities unknown while retaining UNC provenance', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '/repo/.git\n', stderr: '' })
    await getCanonicalRepoKey('C:/repo')
    expect(peekGitCommonDir('C:/repo')).toBeUndefined()
    await getCanonicalRepoKey('//wsl$/Ubuntu/home/dev/repo')
    expect(peekGitCommonDir('//wsl$/Ubuntu/home/dev/repo')).toBe('/repo/.git')
  })
})
