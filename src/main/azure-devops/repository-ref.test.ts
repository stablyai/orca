import { describe, expect, it } from 'vitest'
import { parseAzureDevOpsRepoRef } from './repository-ref'

describe('parseAzureDevOpsRepoRef', () => {
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
})
