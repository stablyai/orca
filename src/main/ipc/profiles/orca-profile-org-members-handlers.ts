import { ipcMain } from 'electron'
import type {
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult
} from '../../../shared/orca-profiles/orca-profiles'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import { listOrcaProfileOrgMembers } from '../../orca-profiles/cloud-org/profile-cloud-org-members-service'
import { registerOrcaProfileOrgCloudHandlers } from './orca-profile-org-cloud-handlers'

function orgMembersScopedArgs(args: unknown): { orgId: string; record: Record<string, unknown> } {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_orca_profile_org_selection')
  }
  const record = args as Record<string, unknown>
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_orca_profile_org_selection')
  }
  return { orgId, record }
}

export function registerOrcaProfileOrgMemberHandlers(): void {
  ipcMain.handle(
    'orcaProfiles:orgMembersList',
    async (
      _event,
      rawArgs: OrcaProfileOrgMembersListArgs
    ): Promise<OrcaProfileOrgMembersListResult> =>
      listOrcaProfileOrgMembers(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  registerOrcaProfileOrgCloudHandlers()
}
