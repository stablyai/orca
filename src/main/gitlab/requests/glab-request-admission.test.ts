import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, glabExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    glabExecFileAsyncMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn()
  })
)

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('../../github/local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))
import { _resetProjectRefCache, getProjectRef } from '../projects/gitlab-project-ref-resolution'
import './glab-request-admission'
import '../issues/gitlab-issue-source-resolution'
import { _resetRemoteNameListingCache } from '../../git/remotes/remote-name-listing'

function mockGitRemoteCommands(remotes: Record<string, string>): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] !== 'get-url') {
      return { stdout: `${Object.keys(remotes).join('\n')}\n` }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const url = remotes[args[2] ?? '']
      if (!url) {
        throw new Error(`fatal: No such remote '${args[2]}'`)
      }
      return { stdout: url }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

describe('gitlab project ref resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
    _resetRemoteNameListingCache()
    readLocalGitConfigSignatureMock
      .mockReset()
      .mockImplementation(async (context: { wslDistro?: string }) =>
        context.wslDistro ? undefined : 'sig-1'
      )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['sig-2', undefined])(
    'does not return a warm identity after freshness was lost (%s) and the probe timed out',
    async (signature) => {
      mockGitRemoteCommands({ origin: 'git@gitlab.com:team/project.git\n' })
      await expect(getProjectRef('/repo')).resolves.toEqual({
        host: 'gitlab.com',
        path: 'team/project'
      })
      gitExecFileAsyncMock.mockRejectedValue(new Error('git remote get-url timed out'))
      readLocalGitConfigSignatureMock.mockResolvedValue(signature)

      await expect(getProjectRef('/repo')).resolves.toBeNull()
    }
  )
})
