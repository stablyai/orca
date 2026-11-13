// Settings › Enterprise for the active profile's team: the pane's state, the single sign-on setup
// link, and the team's verified email domains. Business refusals come back as values; only a 401
// refreshes the session.
import type {
  OrcaOrgSsoDomainRefusal,
  OrcaProfileOrgEnterpriseResult,
  OrcaProfileOrgSsoDomainResult,
  OrcaProfileOrgSsoSetupLinkResult
} from '../../../shared/orca-org-enterprise'
import {
  getOrcaCloudAuthConfig,
  isOrcaCloudDevAuthEnabled
} from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import {
  changeOrcaCloudOrgSsoDomain,
  createOrcaCloudOrgSsoSetupLink,
  getOrcaCloudOrgEnterprise,
  type OrgSsoDomainAction
} from './profile-cloud-org-enterprise-client'
import { runOrgMemberCall } from './profile-cloud-org-members-service'

type CommonFailure = Exclude<
  OrcaProfileOrgEnterpriseResult,
  { status: 'ok' } | { status: 'unconfigured' } | { status: 'reconnect-required' }
>

export function mapOrgEnterpriseRequestError(error: OrcaCloudRequestError): CommonFailure {
  switch (error.statusCode) {
    case 403:
      return { status: 'forbidden' }
    case 404:
    case 405:
      // An unknown route (no JSON error code) means this auth deployment predates Enterprise.
      return error.errorCode
        ? { status: 'failed', error: error.message }
        : { status: 'unsupported' }
    case 429:
      return { status: 'rate-limited' }
    case 502:
    case 503:
      return { status: 'unavailable' }
    default:
      return { status: 'failed', error: error.message }
  }
}

const DOMAIN_REFUSALS: Record<string, OrcaOrgSsoDomainRefusal> = {
  invalid_domain: 'invalid-domain',
  invalid_request: 'invalid-domain',
  public_domain: 'public-domain',
  too_many_domains: 'too-many-domains',
  domain_not_found: 'domain-not-found',
  domain_taken: 'domain-taken',
  record_not_found: 'record-not-found',
  dns_unavailable: 'dns-unavailable'
}

export async function getOrcaProfileOrgEnterprise(
  userDataPath: string,
  orgId: string
): Promise<OrcaProfileOrgEnterpriseResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  // The in-app fake account has no auth service behind it: nothing to show.
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'unsupported' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    getOrcaCloudOrgEnterprise(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', enterprise: result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return mapOrgEnterpriseRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function createOrcaProfileOrgSsoSetupLink(
  userDataPath: string,
  orgId: string
): Promise<OrcaProfileOrgSsoSetupLinkResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'unsupported' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    createOrcaCloudOrgSsoSetupLink(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', ...result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      if (result.error.statusCode === 403 && result.error.errorCode === 'recent_sign_in_required') {
        return { status: 'recent-sign-in-required' }
      }
      if (result.error.statusCode === 403 && result.error.errorCode === 'not_entitled') {
        return { status: 'not-entitled' }
      }
      return mapOrgEnterpriseRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function changeOrcaProfileOrgSsoDomain(
  userDataPath: string,
  args: { orgId: string; domain: string; action: OrgSsoDomainAction }
): Promise<OrcaProfileOrgSsoDomainResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'unsupported' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    changeOrcaCloudOrgSsoDomain(configState.config, session, args)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', domain: result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error': {
      const refusal = result.error.errorCode ? DOMAIN_REFUSALS[result.error.errorCode] : undefined
      if (refusal) {
        return { status: 'refused', reason: refusal }
      }
      if (result.error.statusCode === 403 && result.error.errorCode === 'not_entitled') {
        return { status: 'not-entitled' }
      }
      return mapOrgEnterpriseRequestError(result.error)
    }
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}
