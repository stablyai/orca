// Auth's team-delete routes (TEAM-DELETE). Same Bearer token, timeout and no-redirect rule as the
// other /v1/desktop/orgs routes.
import {
  isPlainRecord,
  normalizeOrgDeleteBlockers,
  type OrcaOrgDeleteBlocker
} from '../../../shared/orca-org-delete'
import type { OrcaCloudAuthConfig } from '../cloud-auth/profile-cloud-auth-config'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { OrcaCloudRequestError } from '../cloud-auth/profile-cloud-client'
import { extractErrorCode, orgMembersUrl, requestInit } from './profile-cloud-org-members-client'

export type OrgDeleteCheck = { deletable: boolean; blockers: OrcaOrgDeleteBlocker[] }
export type OrgDeleteOutcome =
  | { kind: 'deleted' }
  | { kind: 'blocked'; blockers: OrcaOrgDeleteBlocker[] }

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
  // Never call a team deletable while auth lists a blocker this desktop understands.
  return { deletable: body.deletable === true && blockers.length === 0, blockers }
}

export async function checkOrcaCloudOrgDelete(
  config: OrcaCloudAuthConfig,
  session: OrcaCloudSession,
  orgId: string
): Promise<OrgDeleteCheck> {
  const response = await fetch(
    orgMembersUrl(config, orgId, '/delete-check'),
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
    orgMembersUrl(config, args.orgId, '/delete'),
    requestInit('POST', session.accessToken, { confirmName: args.confirmName })
  )
  if (response.status === 409) {
    const body = await readJson(response)
    if (body.error === 'not_deletable') {
      return { kind: 'blocked', blockers: normalizeOrgDeleteBlockers(body.blockers) }
    }
    throw new OrcaCloudRequestError(409, typeof body.error === 'string' ? body.error : undefined)
  }
  if (!response.ok) {
    throw new OrcaCloudRequestError(response.status, await extractErrorCode(response))
  }
  return { kind: 'deleted' }
}
