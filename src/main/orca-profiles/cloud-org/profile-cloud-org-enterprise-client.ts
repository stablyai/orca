// Auth's Settings › Enterprise routes for a team (single sign-on and directory sync). Same Bearer
// token, timeout and no-redirect rule as the other /v1/desktop/orgs routes.
import { isPlainRecord } from '../../../shared/orca-org-delete'
import {
  normalizeOrgEnterprise,
  normalizeOrgSsoDomain,
  type OrcaOrgEnterprise,
  type OrcaOrgSsoDomain
} from '../../../shared/orca-org-enterprise'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { extractErrorCode, orgMembersUrl, requestInit } from './profile-cloud-org-members-client'

async function send(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  const body: unknown = await response.json().catch(() => null)
  return isPlainRecord(body) ? body : {}
}

export async function getOrcaCloudOrgEnterprise(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  orgId: string
): Promise<OrcaOrgEnterprise> {
  return normalizeOrgEnterprise(
    await send(orgMembersUrl(config, orgId, '/enterprise'), requestInit('GET', session.accessToken))
  )
}

/**
 * The identity provider's self-serve setup page for the team's connection. The link needs no
 * sign-in there, so it is only ever handed to the owner who asked: never logged, never stored.
 */
export async function createOrcaCloudOrgSsoSetupLink(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  orgId: string
): Promise<{ url: string; expiresAt: number }> {
  const body = await send(
    orgMembersUrl(config, orgId, '/enterprise/sso/setup-link'),
    requestInit('POST', session.accessToken, {})
  )
  const url = typeof body.url === 'string' ? body.url : ''
  let https = false
  try {
    https = new URL(url).protocol === 'https:'
  } catch {
    https = false
  }
  if (!https || typeof body.expiresAt !== 'number') {
    throw new Error('invalid_orca_cloud_sso_setup_link')
  }
  return { url, expiresAt: body.expiresAt }
}

export type OrgSsoDomainAction = 'add' | 'verify' | 'remove'

const DOMAIN_PATHS: Record<OrgSsoDomainAction, string> = {
  add: '/enterprise/sso/domains',
  verify: '/enterprise/sso/domains/verify',
  remove: '/enterprise/sso/domains/remove'
}

/** Adds, checks or removes one of the team's email domains. A removal answers null. */
export async function changeOrcaCloudOrgSsoDomain(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  args: { orgId: string; domain: string; action: OrgSsoDomainAction }
): Promise<OrcaOrgSsoDomain | null> {
  const body = await send(
    orgMembersUrl(config, args.orgId, DOMAIN_PATHS[args.action]),
    requestInit('POST', session.accessToken, { domain: args.domain })
  )
  if (args.action === 'remove') {
    return null
  }
  const domain = normalizeOrgSsoDomain(body.domain)
  if (!domain) {
    throw new Error('invalid_orca_cloud_sso_domain')
  }
  return domain
}
