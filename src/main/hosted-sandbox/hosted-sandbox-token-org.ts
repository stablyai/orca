// Which team a minted sandbox token speaks for, and the error when it can't be made to speak for
// the team the desktop shows.
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import type { ActiveOrcaProfileState } from '../orca-profiles/profile-index-store'
import { ORG_MISMATCH } from './hosted-sandbox-org-fetch'

/** The `org` claim of a sandbox token (null: personal). Decodes only; the control plane verifies. */
export function readTokenOrg(token: string): string | null {
  let payload: unknown = null
  try {
    payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    // Reported below without echoing the token.
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new EnvironmentProviderError(
      'invalid_response',
      'Orca Cloud auth sent an invalid sandbox token.'
    )
  }
  const org = (payload as { org?: unknown }).org
  return typeof org === 'string' && org ? org : null
}

export function orgSwitchError(active: ActiveOrcaProfileState): EnvironmentProviderError {
  const cloud = active.profile.cloud
  const team = cloud?.activeOrgId
    ? cloud.activeOrgName?.trim() || 'your team'
    : 'your personal account'
  return new EnvironmentProviderError(
    'conflict',
    `Couldn't switch to ${team}. Sign out and back in.`,
    ORG_MISMATCH
  )
}

export async function isNotAMember(response: Response): Promise<boolean> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null)
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { error?: unknown }).error === 'not_a_member'
  )
}
