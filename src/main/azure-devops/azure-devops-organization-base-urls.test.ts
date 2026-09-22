import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAzureDevOpsAuthConfig } from './azure-devops-api-request'
import {
  azureDevOpsOrganizationName,
  getConfiguredAzureDevOpsApiBaseUrls,
  listConfiguredAzureDevOpsOrganizations,
  parseAzureDevOpsApiBaseUrls,
  resolveAzureDevOpsApiBaseUrl
} from './azure-devops-organization-base-urls'

const CONTOSO = 'https://dev.azure.com/contoso-labs'
const FABRIKAM = 'https://dev.azure.com/FabrikamOps'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('parseAzureDevOpsApiBaseUrls', () => {
  it('reads a single entry unchanged', () => {
    expect(parseAzureDevOpsApiBaseUrls(CONTOSO)).toEqual([CONTOSO])
  })

  it('splits a comma-separated list and tolerates surrounding whitespace', () => {
    expect(parseAzureDevOpsApiBaseUrls(`  ${CONTOSO} ,\t${FABRIKAM}  `)).toEqual([CONTOSO, FABRIKAM])
  })

  it('normalizes trailing slashes and a trailing /_apis', () => {
    expect(parseAzureDevOpsApiBaseUrls(`${CONTOSO}/_apis/,${FABRIKAM}///`)).toEqual([CONTOSO, FABRIKAM])
  })

  it('deduplicates entries that differ only in case or trailing slash', () => {
    expect(
      parseAzureDevOpsApiBaseUrls(`${CONTOSO},${CONTOSO}/,https://dev.azure.com/Contoso-Labs`)
    ).toEqual([CONTOSO])
  })

  it('drops empty entries rather than yielding a blank base URL', () => {
    expect(parseAzureDevOpsApiBaseUrls(`,,${CONTOSO}, ,`)).toEqual([CONTOSO])
    expect(parseAzureDevOpsApiBaseUrls('')).toEqual([])
    expect(parseAzureDevOpsApiBaseUrls(null)).toEqual([])
  })
})

describe('azureDevOpsOrganizationName', () => {
  it('reads the final path segment', () => {
    expect(azureDevOpsOrganizationName(CONTOSO)).toBe('contoso-labs')
    expect(azureDevOpsOrganizationName('https://ado.example.com/tfs/DefaultCollection')).toBe(
      'DefaultCollection'
    )
  })

  it('returns null when there is no segment to name', () => {
    expect(azureDevOpsOrganizationName('https://dev.azure.com')).toBeNull()
    expect(azureDevOpsOrganizationName('not a url')).toBeNull()
  })
})

describe('resolveAzureDevOpsApiBaseUrl', () => {
  it('serves the single configured base URL when no organization is named', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', CONTOSO)

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: true, baseUrl: CONTOSO })
    expect(resolveAzureDevOpsApiBaseUrl(undefined)).toEqual({ ok: true, baseUrl: CONTOSO })
  })

  it('serves the first entry of a list when no organization is named', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: true, baseUrl: CONTOSO })
  })

  it('resolves each configured organization to its own base URL', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)

    expect(resolveAzureDevOpsApiBaseUrl('contoso-labs')).toEqual({ ok: true, baseUrl: CONTOSO })
    expect(resolveAzureDevOpsApiBaseUrl('FabrikamOps')).toEqual({ ok: true, baseUrl: FABRIKAM })
  })

  it('matches an organization name case-insensitively', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)

    expect(resolveAzureDevOpsApiBaseUrl('FABRIKAMOPS')).toEqual({ ok: true, baseUrl: FABRIKAM })
    expect(resolveAzureDevOpsApiBaseUrl('Contoso-Labs')).toEqual({ ok: true, baseUrl: CONTOSO })
  })

  it('refuses an organization outside the configured set instead of falling back', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)

    expect(resolveAzureDevOpsApiBaseUrl('attacker')).toEqual({
      ok: false,
      reason: 'unknown-organization'
    })
  })

  it('reports not-configured when nothing is set', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: false, reason: 'not-configured' })
    expect(resolveAzureDevOpsApiBaseUrl('contoso-labs')).toEqual({
      ok: false,
      reason: 'not-configured'
    })
  })
})

describe('listConfiguredAzureDevOpsOrganizations', () => {
  it('lists the configured names in configured order', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO}, ${FABRIKAM}`)

    expect(listConfiguredAzureDevOpsOrganizations()).toEqual(['contoso-labs', 'FabrikamOps'])
  })

  it('exposes no base URL and no credential material', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)
    vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'super-secret-pat')
    vi.stubEnv('ORCA_AZURE_DEVOPS_USERNAME', 'someone@example.com')

    const serialized = JSON.stringify(listConfiguredAzureDevOpsOrganizations())

    expect(serialized).not.toContain('super-secret-pat')
    expect(serialized).not.toContain('someone@example.com')
    expect(serialized).not.toContain('https://')
    expect(serialized).not.toContain('dev.azure.com')
  })

  it('is empty when nothing is configured', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    expect(listConfiguredAzureDevOpsOrganizations()).toEqual([])
  })
})

describe('getAzureDevOpsAuthConfig compatibility', () => {
  it('returns one usable base URL when the env var holds a list', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${CONTOSO},${FABRIKAM}`)

    // Pull-request lookup, PR creation and build-status checks all address a
    // single origin through this field.
    expect(getAzureDevOpsAuthConfig().apiBaseUrl).toBe(CONTOSO)
  })

  it('is null when nothing is configured', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    expect(getAzureDevOpsAuthConfig().apiBaseUrl).toBeNull()
    expect(getConfiguredAzureDevOpsApiBaseUrls()).toEqual([])
  })
})
