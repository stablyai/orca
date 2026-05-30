import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sshExecMock } = vi.hoisted(() => ({
  sshExecMock: vi.fn()
}))

import {
  _resetAzureDevOpsRepoRefCache,
  getAzureDevOpsRepoRefForRemote,
  parseAzureDevOpsRepoRef
} from './repository-ref'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'

describe('parseAzureDevOpsRepoRef', () => {
  beforeEach(() => {
    sshExecMock.mockReset()
    unregisterSshGitProvider('conn-1')
    _resetAzureDevOpsRepoRefCache()
  })

  afterEach(() => {
    unregisterSshGitProvider('conn-1')
    _resetAzureDevOpsRepoRefCache()
  })

  it('parses dev.azure.com HTTPS remotes', () => {
    expect(
      parseAzureDevOpsRepoRef('https://dev.azure.com/acme/Project%20One/_git/repo-name')
    ).toEqual({
      host: 'dev.azure.com',
      organization: 'acme',
      project: 'Project One',
      repository: 'repo-name',
      apiBaseUrl: 'https://dev.azure.com/acme/Project%20One',
      webBaseUrl: 'https://dev.azure.com/acme/Project%20One/_git/repo-name'
    })
  })

  it('parses legacy visualstudio.com HTTPS remotes', () => {
    expect(parseAzureDevOpsRepoRef('https://acme.visualstudio.com/Project/_git/repo.git')).toEqual({
      host: 'acme.visualstudio.com',
      organization: 'acme',
      project: 'Project',
      repository: 'repo',
      apiBaseUrl: 'https://acme.visualstudio.com/Project',
      webBaseUrl: 'https://acme.visualstudio.com/Project/_git/repo'
    })
  })

  it('parses Azure DevOps Services SSH remotes', () => {
    expect(parseAzureDevOpsRepoRef('git@ssh.dev.azure.com:v3/acme/Project/repo')).toEqual({
      host: 'dev.azure.com',
      organization: 'acme',
      project: 'Project',
      repository: 'repo',
      apiBaseUrl: 'https://dev.azure.com/acme/Project',
      webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
    })
  })

  it('parses Azure DevOps Server HTTPS remotes from the _git path convention', () => {
    expect(
      parseAzureDevOpsRepoRef('https://ado.example.com/tfs/DefaultCollection/Project/_git/repo.git')
    ).toEqual({
      host: 'ado.example.com',
      organization: null,
      project: 'Project',
      repository: 'repo',
      apiBaseUrl: 'https://ado.example.com/tfs/DefaultCollection/Project',
      webBaseUrl: 'https://ado.example.com/tfs/DefaultCollection/Project/_git/repo'
    })
  })

  it('ignores non-Azure remotes', () => {
    expect(parseAzureDevOpsRepoRef('git@github.com:stablyai/orca.git')).toBeNull()
  })

  it('resolves repository refs through the SSH git provider for connected repos', async () => {
    sshExecMock.mockResolvedValueOnce({
      stdout: 'git@ssh.dev.azure.com:v3/acme/Project/repo\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getAzureDevOpsRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toEqual({
      host: 'dev.azure.com',
      organization: 'acme',
      project: 'Project',
      repository: 'repo',
      apiBaseUrl: 'https://dev.azure.com/acme/Project',
      webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
    })

    expect(sshExecMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], '/repo')
  })

  it('does not cache transient SSH provider failures as unsupported repos', async () => {
    sshExecMock.mockRejectedValueOnce(new Error('connection closed')).mockResolvedValueOnce({
      stdout: 'git@ssh.dev.azure.com:v3/acme/Project/repo\n',
      stderr: ''
    })
    registerSshGitProvider('conn-1', { exec: sshExecMock } as never)

    await expect(getAzureDevOpsRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toBeNull()
    await expect(getAzureDevOpsRepoRefForRemote('/repo', 'origin', 'conn-1')).resolves.toEqual({
      host: 'dev.azure.com',
      organization: 'acme',
      project: 'Project',
      repository: 'repo',
      apiBaseUrl: 'https://dev.azure.com/acme/Project',
      webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
    })

    expect(sshExecMock).toHaveBeenCalledTimes(2)
  })
})
