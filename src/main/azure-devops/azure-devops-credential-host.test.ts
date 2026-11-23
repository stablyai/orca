import { expect, it } from 'vitest'
import { isTrustedAzureDevOpsCredentialHost } from './azure-devops-api-request'

it('sends env credentials only to hosted Azure DevOps or a host the user named', () => {
  const trust = (url: string, configured: string | null = null, listed?: string) =>
    isTrustedAzureDevOpsCredentialHost(url, configured, listed)
  expect(trust('https://dev.azure.com/contoso/Project')).toBe(true)
  expect(trust('https://contoso.visualstudio.com/Project')).toBe(true)
  // A repo remote pointing anywhere else gets no token.
  expect(trust('https://attacker.example/_git/repo')).toBe(false)
  expect(trust('https://dev.azure.com.attacker.example/x')).toBe(false)
  expect(trust('https://visualstudio.com.attacker.example/x')).toBe(false)
  expect(trust('not a url')).toBe(false)
  // Never over plain http to a hosted or listed host.
  expect(trust('http://dev.azure.com/contoso/Project')).toBe(false)
  expect(trust('http://tfs.contoso.local/tfs/Coll/P', null, 'tfs.contoso.local')).toBe(false)
  // An http base URL the user configured themselves stays allowed, for that exact origin only.
  expect(
    trust('http://tfs.contoso.local:8080/tfs/C/P', 'http://tfs.contoso.local:8080/tfs/C')
  ).toBe(true)
  expect(
    trust('http://tfs.contoso.local:9090/tfs/C/P', 'http://tfs.contoso.local:8080/tfs/C')
  ).toBe(false)
  // Azure DevOps Server: the configured base URL's host, or an explicit list.
  expect(trust('https://tfs.contoso.local/tfs/Coll/P', 'https://tfs.contoso.local/tfs/Coll')).toBe(
    true
  )
  expect(
    trust('https://tfs.contoso.local/tfs/Coll/P', null, 'other.local, TFS.contoso.local')
  ).toBe(true)
  expect(trust('https://tfs.contoso.local/tfs/Coll/P', null, 'other.local')).toBe(false)
})
