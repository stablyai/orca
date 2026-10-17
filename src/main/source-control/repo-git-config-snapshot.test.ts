import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readGitConfigSnapshotValue } from '../../shared/git-config-snapshot-runner'
import {
  __resetRepoGitConfigSnapshotCacheForTests,
  getRepoGitConfigSnapshot
} from './repo-git-config-snapshot'

const { gitExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../github/local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

function configOutput(pushRemote: string): { stdout: string; stderr: string } {
  return { stdout: `branch.feature.pushremote\n${pushRemote}\0`, stderr: '' }
}

async function readPushRemote(): Promise<string | null> {
  const snapshot = await getRepoGitConfigSnapshot('/repo')
  return snapshot ? readGitConfigSnapshotValue(snapshot, 'branch.feature.pushRemote') : null
}

describe('getRepoGitConfigSnapshot', () => {
  beforeEach(() => {
    __resetRepoGitConfigSnapshotCacheForTests()
    gitExecFileAsyncMock.mockReset()
    readLocalGitConfigSignatureMock.mockReset()
    readLocalGitConfigSignatureMock.mockResolvedValue('sig-1')
  })

  it('shares one read across lookups while the config is unchanged', async () => {
    gitExecFileAsyncMock.mockResolvedValue(configOutput('fork'))

    await expect(Promise.all([readPushRemote(), readPushRemote()])).resolves.toEqual([
      'fork',
      'fork'
    ])
    await expect(readPushRemote()).resolves.toBe('fork')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['config', '--list', '-z'], {
      cwd: '/repo'
    })
  })

  it('re-reads as soon as the config files change', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce(configOutput('fork'))
      .mockResolvedValueOnce(configOutput('alice'))

    await expect(readPushRemote()).resolves.toBe('fork')
    readLocalGitConfigSignatureMock.mockResolvedValue('sig-2')
    await expect(readPushRemote()).resolves.toBe('alice')
  })

  it('returns null for a failed read and tries again next time', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: not a git repository'))
      .mockResolvedValueOnce(configOutput('fork'))

    await expect(getRepoGitConfigSnapshot('/repo')).resolves.toBeNull()
    await expect(readPushRemote()).resolves.toBe('fork')
  })

  it('throws for a host whose git does not run in this process', async () => {
    await expect(getRepoGitConfigSnapshot('/repo', 'ssh-1')).rejects.toThrow()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
