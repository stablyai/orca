import { describe, expect, it } from 'vitest'
import { parseAzureDevOpsRepoRef } from './repository-ref'

describe('parseAzureDevOpsRepoRef', () => {
  it('reads the SSH remote older visualstudio.com organizations use', () => {
    const expected = {
      host: 'myorg.visualstudio.com',
      organization: 'myorg',
      project: 'Proj',
      repository: 'Repo',
      apiBaseUrl: 'https://myorg.visualstudio.com/Proj',
      webBaseUrl: 'https://myorg.visualstudio.com/Proj/_git/Repo'
    }
    expect(parseAzureDevOpsRepoRef('myorg@vs-ssh.visualstudio.com:v3/myorg/Proj/Repo')).toEqual(
      expected
    )
    expect(
      parseAzureDevOpsRepoRef('ssh://myorg@vs-ssh.visualstudio.com:22/v3/myorg/Proj/Repo')
    ).toEqual(expected)
    expect(parseAzureDevOpsRepoRef('https://myorg.visualstudio.com/Proj/_git/Repo')).toEqual(
      expected
    )
  })

  it('rejects a vs-ssh organization that would redirect the API host', () => {
    expect(parseAzureDevOpsRepoRef('git@vs-ssh.visualstudio.com:v3/evil.example%23/P/R')).toBeNull()
    expect(
      parseAzureDevOpsRepoRef('ssh://git@vs-ssh.visualstudio.com/v3/evil.example%2F/P/R')
    ).toBeNull()
  })

  it('keeps reading dev.azure.com SSH remotes as before', () => {
    expect(parseAzureDevOpsRepoRef('git@ssh.dev.azure.com:v3/acme/Proj/Repo')).toMatchObject({
      host: 'dev.azure.com',
      organization: 'acme',
      webBaseUrl: 'https://dev.azure.com/acme/Proj/_git/Repo'
    })
  })
})
