import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../../git/command-runner/git-exec-file'

const { gitExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn<() => Promise<string | undefined>>(async () => 'sig-1')
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import { getOwnerRepoForRemote, _resetOwnerRepoCache } from './github-repository-identity'

const REPO = '/tmp/signed-cache-repo'
const THIRTY_SECONDS = 30_000

let remoteUrl = 'https://github.com/stablyai/orca.git'

const remoteGetUrlCalls = (): number =>
  gitExecFileAsyncMock.mock.calls.filter(([args]) => (args as string[])[1] === 'get-url').length

beforeEach(() => {
  _resetOwnerRepoCache()
  vi.useRealTimers()
  gitExecFileAsyncMock.mockReset()
  remoteUrl = 'https://github.com/stablyai/orca.git'
  readLocalGitConfigSignatureMock.mockReset()
  readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-1')
  gitExecFileAsyncMock.mockImplementation(async () => ({ stdout: remoteUrl }))
})

describe('owner/repo identity cache', () => {
  it('re-probes as soon as the git config signature changes', async () => {
    vi.useFakeTimers()
    await getOwnerRepoForRemote(REPO, 'origin')
    expect(remoteGetUrlCalls()).toBe(1)

    remoteUrl = 'https://github.com/other-org/orca.git'
    readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-2')
    vi.setSystemTime(Date.now() + THIRTY_SECONDS)

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'other-org',
      repo: 'orca'
    })
    expect(remoteGetUrlCalls()).toBe(2)
    vi.useRealTimers()
  })
})
