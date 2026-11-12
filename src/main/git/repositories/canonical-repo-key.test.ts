import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitExecFile from '../command-runner/git-exec-file'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFile>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetCanonicalRepoKeyCacheForTests,
  getCanonicalRepoKey,
  peekGitCommonDir
} from './canonical-repo-key'

beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  _resetCanonicalRepoKeyCacheForTests()
  gitExecFileAsyncMock.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
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
