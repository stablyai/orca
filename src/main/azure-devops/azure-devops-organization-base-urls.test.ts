import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAzureDevOpsAuthConfig } from './azure-devops-api-request'
import {
  azureDevOpsOrganizationName,
  getConfiguredAzureDevOpsApiBaseUrls,
  listConfiguredAzureDevOpsOrganizations,
  parseAzureDevOpsApiBaseUrls,
  resolveAzureDevOpsApiBaseUrl
} from './azure-devops-organization-base-urls'

const DOLPHIN = 'https://dev.azure.com/nssf-dolphin'
const DEVOPS = 'https://dev.azure.com/NssfDevOps'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('parseAzureDevOpsApiBaseUrls', () => {
  it('reads a single entry unchanged', () => {
    expect(parseAzureDevOpsApiBaseUrls(DOLPHIN)).toEqual([DOLPHIN])
  })

  it('splits a comma-separated list and tolerates surrounding whitespace', () => {
    expect(parseAzureDevOpsApiBaseUrls(`  ${DOLPHIN} ,\t${DEVOPS}  `)).toEqual([DOLPHIN, DEVOPS])
  })

  it('normalizes trailing slashes and a trailing /_apis', () => {
    expect(parseAzureDevOpsApiBaseUrls(`${DOLPHIN}/_apis/,${DEVOPS}///`)).toEqual([DOLPHIN, DEVOPS])
  })

  it('deduplicates entries that differ only in case or trailing slash', () => {
    expect(
      parseAzureDevOpsApiBaseUrls(`${DOLPHIN},${DOLPHIN}/,https://dev.azure.com/NSSF-Dolphin`)
    ).toEqual([DOLPHIN])
  })

  it('drops empty entries rather than yielding a blank base URL', () => {
    expect(parseAzureDevOpsApiBaseUrls(`,,${DOLPHIN}, ,`)).toEqual([DOLPHIN])
    expect(parseAzureDevOpsApiBaseUrls('')).toEqual([])
    expect(parseAzureDevOpsApiBaseUrls(null)).toEqual([])
  })
})

describe('azureDevOpsOrganizationName', () => {
  it('reads the final path segment', () => {
    expect(azureDevOpsOrganizationName(DOLPHIN)).toBe('nssf-dolphin')
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
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', DOLPHIN)

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: true, baseUrl: DOLPHIN })
    expect(resolveAzureDevOpsApiBaseUrl(undefined)).toEqual({ ok: true, baseUrl: DOLPHIN })
  })

  it('serves the first entry of a list when no organization is named', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: true, baseUrl: DOLPHIN })
  })

  it('resolves each configured organization to its own base URL', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)

    expect(resolveAzureDevOpsApiBaseUrl('nssf-dolphin')).toEqual({ ok: true, baseUrl: DOLPHIN })
    expect(resolveAzureDevOpsApiBaseUrl('NssfDevOps')).toEqual({ ok: true, baseUrl: DEVOPS })
  })

  it('matches an organization name case-insensitively', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)

    expect(resolveAzureDevOpsApiBaseUrl('NSSFDEVOPS')).toEqual({ ok: true, baseUrl: DEVOPS })
    expect(resolveAzureDevOpsApiBaseUrl('NSSF-Dolphin')).toEqual({ ok: true, baseUrl: DOLPHIN })
  })

  it('refuses an organization outside the configured set instead of falling back', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)

    expect(resolveAzureDevOpsApiBaseUrl('attacker')).toEqual({
      ok: false,
      reason: 'unknown-organization'
    })
  })

  it('reports not-configured when nothing is set', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    expect(resolveAzureDevOpsApiBaseUrl()).toEqual({ ok: false, reason: 'not-configured' })
    expect(resolveAzureDevOpsApiBaseUrl('nssf-dolphin')).toEqual({
      ok: false,
      reason: 'not-configured'
    })
  })
})

describe('listConfiguredAzureDevOpsOrganizations', () => {
  it('lists the configured names in configured order', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN}, ${DEVOPS}`)

    expect(listConfiguredAzureDevOpsOrganizations()).toEqual(['nssf-dolphin', 'NssfDevOps'])
  })

  it('exposes no base URL and no credential material', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)
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
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', `${DOLPHIN},${DEVOPS}`)

    // Pull-request lookup, PR creation and build-status checks all address a
    // single origin through this field.
    expect(getAzureDevOpsAuthConfig().apiBaseUrl).toBe(DOLPHIN)
  })

  it('is null when nothing is configured', () => {
    vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', '')

    expect(getAzureDevOpsAuthConfig().apiBaseUrl).toBeNull()
    expect(getConfiguredAzureDevOpsApiBaseUrls()).toEqual([])
  })
})
