// Read-only team IPC the desktop still needs: the roster (names, presence, owners), the person's
// own two-factor state, and the team's MFA policy as it applies to them. Managing the team, its
// members and its policies happens in the web console (see orca-cloud-console-handlers.ts).
import { ipcMain } from 'electron'
import type {
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult
} from '../../../shared/orca-profiles'
import type { OrcaAccountMfaResult } from '../../../shared/orca-account-mfa'
import { getOrcaProfileAccountMfa } from '../../orca-profiles/cloud-mfa/profile-cloud-mfa-service'
import type { OrcaTeamMfaPolicyResult } from '../../../shared/orca-team-mfa-policy'
import { getOrcaTeamMfaPolicy } from '../../orca-profiles/cloud-mfa/profile-cloud-team-mfa-service'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { listOrcaProfileOrgMembers } from '../../orca-profiles/cloud-org/profile-cloud-org-members-service'
import { registerOrcaCloudConsoleHandlers } from './orca-cloud-console-handlers'

function orgIdFromUnknown(args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_orca_profile_org_selection')
  }
  return orgId
}

export function registerOrcaProfileOrgMemberHandlers(): void {
  registerOrcaCloudConsoleHandlers()

  ipcMain.handle('orcaProfiles:accountMfa', async (): Promise<OrcaAccountMfaResult> =>
    getOrcaProfileAccountMfa(getProfileUserDataPath())
  )

  ipcMain.handle(
    'orcaProfiles:teamMfaPolicy',
    async (_event, rawArgs: unknown): Promise<OrcaTeamMfaPolicyResult> =>
      getOrcaTeamMfaPolicy(getProfileUserDataPath(), orgIdFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'orcaProfiles:orgMembersList',
    async (
      _event,
      rawArgs: OrcaProfileOrgMembersListArgs
    ): Promise<OrcaProfileOrgMembersListResult> =>
      listOrcaProfileOrgMembers(getProfileUserDataPath(), orgIdFromUnknown(rawArgs))
  )
}
