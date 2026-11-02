import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAzureDevOpsApiBases } from './api-bases'
import type { AzureDevOpsRepoRef } from '../repository-ref'

const OLD_ENV = process.env

function cloudRepo(): AzureDevOpsRepoRef {
  return {
    host: 'dev.azure.com',
    organization: 'acme',
    project: 'Project',
    repository: 'repo',
    apiBaseUrl: 'https://dev.azure.com/acme/Project',
    webBaseUrl: 'https://dev.azure.com/acme/Project/_git/repo'
  }
}

describe('resolveAzureDevOpsApiBases', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_AZURE_DEVOPS_API_BASE_URL
  })
  afterEach(() => {
    process.env = OLD_ENV
  })

  it('derives collection, project, team and web bases from a hosted repo', () => {
    const bases = resolveAzureDevOpsApiBases(cloudRepo())
    expect(bases.collection).toBe('https://dev.azure.com/acme')
    expect(bases.project).toBe('https://dev.azure.com/acme/Project')
    expect(bases.team('Team A')).toBe('https://dev.azure.com/acme/Project/Team%20A')
    expect(bases.workItemWebUrl(42)).toBe('https://dev.azure.com/acme/Project/_workitems/edit/42')
  })

  it('keeps the collection segment for on-prem servers', () => {
    const bases = resolveAzureDevOpsApiBases({
      host: 'ado.example.com',
      organization: null,
      project: 'MyProject',
      repository: 'my-repo',
      apiBaseUrl: 'https://ado.example.com:8443/tfs/MyCollection/MyProject',
      webBaseUrl: 'https://ado.example.com:8443/tfs/MyCollection/MyProject/_git/my-repo'
    })
    expect(bases.collection).toBe('https://ado.example.com:8443/tfs/MyCollection')
    expect(bases.project).toBe('https://ado.example.com:8443/tfs/MyCollection/MyProject')
  })
})
