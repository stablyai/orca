import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import {
  changeOrcaCloudOrgSsoDomain,
  createOrcaCloudOrgSsoSetupLink,
  getOrcaCloudOrgEnterprise
} from './profile-cloud-org-enterprise-client'
import { mapOrgEnterpriseRequestError } from './profile-cloud-org-enterprise-service'

const base = 'https://auth.test'
const config: OrcaCloudAuthConfig = {
  apiBaseUrl: base,
  authorizeEndpoint: `${base}/a`,
  sessionEndpoint: `${base}/s`,
  refreshEndpoint: `${base}/r`,
  capabilitiesEndpoint: `${base}/c`,
  profileEndpoint: `${base}/p`,
  orgEndpoint: `${base}/o`,
  logoutEndpoint: `${base}/l`,
  relayTokenEndpoint: `${base}/rt`,
  connectorTokenEndpoint: `${base}/ct`,
  relayDirectorUrl: base,
  clientId: 'orca-desktop',
  scope: 'openid'
}
const session: OrcaCloudSession = {
  accessToken: 'token',
  refreshToken: 'refresh',
  expiresAt: 4_102_444_800_000,
  capabilities: { flags: {}, refreshedAt: 0 }
}

function respond(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  )
}

function call(): { url: unknown; init: RequestInit } {
  const [url, init] = vi.mocked(fetch).mock.calls[0] ?? []
  return { url, init: init ?? {} }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const RECORD = { type: 'TXT', name: '_orca-verify.acme.com', value: 'orca-verify=abc' }

describe('Settings › Enterprise client (single sign-on and directory sync)', () => {
  it('reads the pane state from auth; directory sync is available only when auth says so', async () => {
    respond(200, {
      canManage: true,
      sso: { entitled: true, status: 'live', idp: 'Okta', required: true, domains: [] },
      scim: { available: true, status: 'waiting', setupUrl: 'https://idp.test/org/settings/1' }
    })
    const enterprise = await getOrcaCloudOrgEnterprise(config, session, 'org_1')
    expect(call().url).toBe(`${base}/v1/desktop/orgs/org_1/enterprise`)
    expect(enterprise.sso).toMatchObject({ status: 'live', idp: 'Okta', required: true })
    expect(enterprise.scim).toMatchObject({
      available: true,
      status: 'waiting',
      setupUrl: 'https://idp.test/org/settings/1'
    })

    respond(200, { canManage: true, sso: { entitled: true, status: 'live' } })
    expect((await getOrcaCloudOrgEnterprise(config, session, 'org_1')).scim.available).toBe(false)
  })

  it('mints a setup link, and refuses one that is not https', async () => {
    respond(200, { url: 'https://idp.test/setup/abc', expiresAt: 123 })
    await expect(createOrcaCloudOrgSsoSetupLink(config, session, 'org_1')).resolves.toEqual({
      url: 'https://idp.test/setup/abc',
      expiresAt: 123
    })
    expect(call().url).toBe(`${base}/v1/desktop/orgs/org_1/enterprise/sso/setup-link`)
    expect(call().init.method).toBe('POST')
    for (const url of ['http://idp.test/setup', 'javascript:alert(1)', '', undefined]) {
      respond(200, { url, expiresAt: 123 })
      await expect(createOrcaCloudOrgSsoSetupLink(config, session, 'org_1')).rejects.toThrow(
        'invalid_orca_cloud_sso_setup_link'
      )
    }
  })

  it('carries auth’s refusal code for the service to explain', async () => {
    respond(403, { error: 'recent_sign_in_required' })
    await expect(createOrcaCloudOrgSsoSetupLink(config, session, 'org_1')).rejects.toMatchObject({
      statusCode: 403,
      errorCode: 'recent_sign_in_required'
    })
  })

  it('adds, checks and removes a domain on their own routes', async () => {
    const domain = { domain: 'acme.com', status: 'pending', record: RECORD }
    respond(200, { domain })
    await expect(
      changeOrcaCloudOrgSsoDomain(config, session, {
        orgId: 'org_1',
        domain: 'acme.com',
        action: 'add'
      })
    ).resolves.toEqual(domain)
    expect(call().url).toBe(`${base}/v1/desktop/orgs/org_1/enterprise/sso/domains`)
    expect(call().init.body).toBe(JSON.stringify({ domain: 'acme.com' }))

    respond(200, { domain: { ...domain, status: 'verified' } })
    await changeOrcaCloudOrgSsoDomain(config, session, {
      orgId: 'org_1',
      domain: 'acme.com',
      action: 'verify'
    })
    expect(call().url).toBe(`${base}/v1/desktop/orgs/org_1/enterprise/sso/domains/verify`)

    respond(200, { ok: true })
    await expect(
      changeOrcaCloudOrgSsoDomain(config, session, {
        orgId: 'org_1',
        domain: 'acme.com',
        action: 'remove'
      })
    ).resolves.toBeNull()
    expect(call().url).toBe(`${base}/v1/desktop/orgs/org_1/enterprise/sso/domains/remove`)
  })

  it('an auth deployment without the routes reads as unsupported, not as an error', () => {
    expect(mapOrgEnterpriseRequestError(new OrcaCloudRequestError(404))).toEqual({
      status: 'unsupported'
    })
    expect(
      mapOrgEnterpriseRequestError(new OrcaCloudRequestError(403, 'insufficient_role'))
    ).toEqual({ status: 'forbidden' })
    expect(mapOrgEnterpriseRequestError(new OrcaCloudRequestError(429, 'rate_limited'))).toEqual({
      status: 'rate-limited'
    })
    expect(
      mapOrgEnterpriseRequestError(new OrcaCloudRequestError(502, 'directory_unavailable'))
    ).toEqual({ status: 'unavailable' })
  })
})
