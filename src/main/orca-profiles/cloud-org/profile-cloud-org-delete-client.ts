// Auth's team-delete routes (TEAM-DELETE). Same Bearer token, timeout and no-redirect rule as the
// other /v1/desktop/orgs routes.
import {
  isPlainRecord,
  normalizeOrgDeleteBlockers,
  normalizeOrgDeleteCancelsSubscription,
  ORCA_ORG_DELETE_SUPPORTS,
  type OrcaOrgDeleteBlocker,
  type OrcaOrgDeleteCancelsSubscription
} from '../../../shared/orca-org-delete'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { extractErrorCode, orgMembersUrl, requestInit } from './profile-cloud-org-members-client'

export type OrgDeleteCheck = {
  deletable: boolean
  blockers: OrcaOrgDeleteBlocker[]
  cancelsSubscription?: OrcaOrgDeleteCancelsSubscription
}
export type OrgDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'blocked'; blockers: OrcaOrgDeleteBlocker[] }
  | { kind: 'failed-after-cancel'; cause: string }

/** EP-10: both routes, so auth may offer (and report) ending a cancelling plan on delete. */
const SUPPORTS_QUERY = `?supports=${ORCA_ORG_DELETE_SUPPORTS}`

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json()
    return isPlainRecord(body) ? body : {}
  } catch {
    return {}
  }
}

export function parseOrgDeleteCheck(body: Record<string, unknown>): OrgDeleteCheck {
  const blockers = normalizeOrgDeleteBlockers(body.blockers)
  const cancelsSubscription = normalizeOrgDeleteCancelsSubscription(body.cancelsSubscription)
  // Never call a team deletable while auth lists a blocker this desktop understands.
  return {
    deletable: body.deletable === true && blockers.length === 0,
    blockers,
    ...(cancelsSubscription ? { cancelsSubscription } : {})
  }
}

export async function checkOrcaCloudOrgDelete(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  orgId: string
): Promise<OrgDeleteCheck> {
  const response = await fetch(
    orgMembersUrl(config, orgId, `/delete-check${SUPPORTS_QUERY}`),
    requestInit('GET', session.accessToken)
  )
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  return parseOrgDeleteCheck(await readJson(response))
}

/** 409 not_deletable comes back as `blocked` with auth's blockers; other failures throw. */
export async function deleteOrcaCloudOrg(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  args: { orgId: string; confirmName: string }
): Promise<OrgDeleteOutcome> {
  const response = await fetch(
    orgMembersUrl(config, args.orgId, `/delete${SUPPORTS_QUERY}`),
    requestInit('POST', session.accessToken, { confirmName: args.confirmName })
  )
  if (response.ok) {
    return { kind: 'deleted' }
  }
  const body = await readJson(response)
  const error = typeof body.error === 'string' ? body.error : undefined
  // EP-10: the plan already ended (whatever status the rest failed with): say so, never "nothing happened".
  if (error === 'delete_failed_after_cancel') {
    return {
      kind: 'failed-after-cancel',
      cause: typeof body.cause === 'string' ? body.cause : 'unknown'
    }
  }
  if (response.status === 409 && error === 'not_deletable') {
    return { kind: 'blocked', blockers: normalizeOrgDeleteBlockers(body.blockers) }
  }
  throw new OrcaCloudRequestError(response.status, error)
}
