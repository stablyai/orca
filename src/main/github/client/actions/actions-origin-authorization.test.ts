import { afterEach, expect, it, vi } from 'vitest'
import * as execution from '../../github-api-repository'
import * as gh from '../../gh-utils'
import { withActionsRead } from './actions-read-request'
import { startActionsArtifactDownload } from './actions-artifacts'

const origin = { owner: 'Acme', repo: 'Widgets', host: 'github.com' }
afterEach(() => vi.restoreAllMocks())

it.each([
  { owner: 'elsewhere', repo: 'private', host: 'github.com' },
  { owner: 'acme', repo: 'widgets', host: 'another.example' }
])(
  'refuses another repository or host before artifact metadata or archive execution',
  async (repository) => {
    vi.spyOn(execution, 'getGitHubApiRepositoryForRemote').mockResolvedValue(origin)
    const command = vi
      .spyOn(gh, 'ghExecFileAsync')
      .mockRejectedValue(new Error('Unexpected gh execution'))
    await expect(
      startActionsArtifactDownload('/registered', { repository, runId: 9, artifactId: 7 })
    ).rejects.toThrow('does not match the registered origin')
    expect(command).not.toHaveBeenCalled()
  }
)

it.each([
  undefined,
  { owner: 'acme', repo: 'widgets' },
  { owner: 'ACME', repo: 'WIDGETS', host: 'GITHUB.COM' }
])(
  'uses the verified origin for a matching or legacy host-less request: %j',
  async (repository) => {
    const discover = vi
      .spyOn(execution, 'getGitHubApiRepositoryForRemote')
      .mockResolvedValue(origin)
    await expect(
      withActionsRead(
        '/registered',
        repository,
        'ssh-host',
        { wslDistro: 'Ubuntu' },
        undefined,
        async (resolved) => resolved
      )
    ).resolves.toEqual(origin)
    expect(discover).toHaveBeenCalledWith(
      '/registered',
      'origin',
      'ssh-host',
      { wslDistro: 'Ubuntu' },
      { requireVerifiedSshProbe: true }
    )
  }
)

it('refuses a supplied slug when the registered origin cannot be verified', async () => {
  vi.spyOn(execution, 'getGitHubApiRepositoryForRemote').mockResolvedValue(null)
  await expect(
    withActionsRead('/registered', origin, undefined, {}, undefined, async () => true)
  ).rejects.toThrow('verified GitHub repository is required')
})
