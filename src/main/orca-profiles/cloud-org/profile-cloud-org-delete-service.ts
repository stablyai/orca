// Team delete for the active profile (TEAM-DELETE): the pre-check and the delete itself. Business
// refusals come back as values; only a 401 refreshes the session.
import type {
  OrcaProfileOrgDeleteArgs,
  OrcaProfileOrgDeleteCheckResult,
  OrcaProfileOrgDeleteResult
} from '../../../shared/orca-org-delete'
import { ensureActiveOrcaProfile } from '../profile-index-store'
import { getOrcaCloudAuthConfig, isOrcaCloudDevAuthEnabled } from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { removeDevOrganization } from '../cloud-auth/profile-cloud-dev-auth'
import { runOrgMemberCall } from './profile-cloud-org-members-service'
import { checkOrcaCloudOrgDelete, deleteOrcaCloudOrg } from './profile-cloud-org-delete-client'

type CommonFailure = Exclude<
  OrcaProfileOrgDeleteCheckResult,
  { status: 'ok' } | { status: 'unconfigured' } | { status: 'reconnect-required' }
>

export function mapOrgDeleteRequestError(error: OrcaCloudRequestError): CommonFailure {
  switch (error.statusCode) {
    case 403:
      return { status: 'forbidden' }
    case 404:
    case 405:
      // An unknown route (no JSON error code) means this auth deployment predates team delete.
      return error.errorCode
        ? { status: 'failed', error: error.message }
        : { status: 'unsupported' }
    case 429:
      return { status: 'rate-limited' }
    case 503:
      return { status: 'unavailable' }
    default:
      return { status: 'failed', error: error.message }
  }
}

export async function checkOrcaProfileOrgDelete(
  userDataPath: string,
  orgId: string
): Promise<OrcaProfileOrgDeleteCheckResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    return { status: 'ok', deletable: true, blockers: [] }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    checkOrcaCloudOrgDelete(configState.config, session, orgId)
  )
  switch (result.status) {
    case 'ok':
      return { status: 'ok', ...result.value }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return mapOrgDeleteRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}

export async function deleteOrcaProfileOrg(
  userDataPath: string,
  args: OrcaProfileOrgDeleteArgs
): Promise<OrcaProfileOrgDeleteResult> {
  const active = ensureActiveOrcaProfile(userDataPath)
  if (isOrcaCloudDevAuthEnabled()) {
    removeDevOrganization(args.orgId)
    return { status: 'deleted' }
  }
  const configState = getOrcaCloudAuthConfig()
  if (!configState.configured) {
    return { status: 'unconfigured' }
  }
  const result = await runOrgMemberCall(configState.config, active, userDataPath, (session) =>
    deleteOrcaCloudOrg(configState.config, session, args)
  )
  switch (result.status) {
    case 'ok':
      return result.value.kind === 'deleted'
        ? { status: 'deleted' }
        : { status: 'blocked', blockers: result.value.blockers }
    case 'reconnect-required':
      return { status: 'reconnect-required' }
    case 'request-error':
      return result.error.statusCode === 400 && result.error.errorCode === 'confirm_mismatch'
        ? { status: 'confirm-mismatch' }
        : mapOrgDeleteRequestError(result.error)
    case 'failed':
      return { status: 'failed', error: result.error }
  }
}
