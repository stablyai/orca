import { isValidOrgName, ORCA_ORG_NAME_MAX_LENGTH } from '../../../shared/orca-org-management'
import type { OrcaProfileOrgCreateResult } from '../../../shared/orca-org-management'
import { ipcMain } from 'electron'
import type {
  OrcaOrgRole,
  OrcaProfileOrgInviteRevokeArgs,
  OrcaProfileOrgMemberChangeRoleArgs,
  OrcaProfileOrgMemberInviteArgs,
  OrcaProfileOrgMemberMutationResult,
  OrcaProfileOrgMemberRemoveArgs,
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult
} from '../../../shared/orca-profiles'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import {
  changeOrcaProfileOrgMemberRole,
  createOrcaProfileOrg,
  inviteOrcaProfileOrgMember,
  leaveOrcaProfileOrg,
  resendOrcaProfileOrgInvite,
  listOrcaProfileOrgMembers,
  removeOrcaProfileOrgMember,
  revokeOrcaProfileOrgInvite
} from '../../orca-profiles/cloud-org/profile-cloud-org-members-service'
import {
  checkOrcaProfileOrgDelete,
  deleteOrcaProfileOrg
} from '../../orca-profiles/cloud-org/profile-cloud-org-delete-service'
import {
  ORCA_ORG_DELETE_CONFIRM_MAX_LENGTH,
  type OrcaProfileOrgDeleteCheckResult,
  type OrcaProfileOrgDeleteResult
} from '../../../shared/orca-org-delete'

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

function orgRoleFromUnknown(value: unknown): OrcaOrgRole {
  if (value === 'owner' || value === 'admin' || value === 'member') {
    return value
  }
  throw new Error('invalid_orca_org_role')
}

function orgEmailFromUnknown(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (!email) {
    throw new Error('invalid_orca_org_member_email')
  }
  return email
}

function orgUserIdFromUnknown(value: unknown): string {
  const userId = typeof value === 'string' ? value.trim() : ''
  if (!userId) {
    throw new Error('invalid_orca_org_member_user')
  }
  return userId
}

function orgMemberInviteArgsFromUnknown(args: unknown): OrcaProfileOrgMemberInviteArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email), role: orgRoleFromUnknown(record.role) }
}

function orgInviteRevokeArgsFromUnknown(args: unknown): OrcaProfileOrgInviteRevokeArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email) }
}

function orgMemberChangeRoleArgsFromUnknown(args: unknown): OrcaProfileOrgMemberChangeRoleArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return {
    orgId,
    userId: orgUserIdFromUnknown(record.userId),
    role: orgRoleFromUnknown(record.role)
  }
}

function orgMemberRemoveArgsFromUnknown(args: unknown): OrcaProfileOrgMemberRemoveArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, userId: orgUserIdFromUnknown(record.userId) }
}

function orgCreateNameFromUnknown(args: unknown): string {
  const record = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!name || name.length > ORCA_ORG_NAME_MAX_LENGTH || !isValidOrgName(name)) {
    throw new Error('invalid_orca_org_name')
  }
  return name
}

/** The name exactly as typed (auth compares it case-sensitively), so it is never trimmed here. */
function orgDeleteConfirmNameFromUnknown(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > ORCA_ORG_DELETE_CONFIRM_MAX_LENGTH) {
    throw new Error('invalid_orca_org_delete_confirm_name')
  }
  return value
}

export function registerOrcaProfileOrgMemberHandlers(): void {
  ipcMain.handle(
    'orcaProfiles:orgDeleteCheck',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgDeleteCheckResult> =>
      checkOrcaProfileOrgDelete(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  ipcMain.handle(
    'orcaProfiles:orgDelete',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgDeleteResult> => {
      const { orgId, record } = orgMembersScopedArgs(rawArgs)
      return deleteOrcaProfileOrg(getProfileUserDataPath(), {
        orgId,
        confirmName: orgDeleteConfirmNameFromUnknown(record.confirmName)
      })
    }
  )

  ipcMain.handle(
    'orcaProfiles:orgInviteResend',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgMemberMutationResult> =>
      resendOrcaProfileOrgInvite(getProfileUserDataPath(), orgMemberInviteArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'orcaProfiles:orgLeave',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgMemberMutationResult> =>
      leaveOrcaProfileOrg(getProfileUserDataPath(), { orgId: orgMembersScopedArgs(rawArgs).orgId })
  )

  ipcMain.handle(
    'orcaProfiles:orgCreate',
    async (_event, rawArgs: unknown): Promise<OrcaProfileOrgCreateResult> =>
      createOrcaProfileOrg(getProfileUserDataPath(), { name: orgCreateNameFromUnknown(rawArgs) })
  )

  ipcMain.handle(
    'orcaProfiles:orgMembersList',
    async (
      _event,
      rawArgs: OrcaProfileOrgMembersListArgs
    ): Promise<OrcaProfileOrgMembersListResult> =>
      listOrcaProfileOrgMembers(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  ipcMain.handle(
    'orcaProfiles:orgMemberInvite',
    async (
      _event,
      rawArgs: OrcaProfileOrgMemberInviteArgs
    ): Promise<OrcaProfileOrgMemberMutationResult> =>
      inviteOrcaProfileOrgMember(getProfileUserDataPath(), orgMemberInviteArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'orcaProfiles:orgInviteRevoke',
    async (
      _event,
      rawArgs: OrcaProfileOrgInviteRevokeArgs
    ): Promise<OrcaProfileOrgMemberMutationResult> =>
      revokeOrcaProfileOrgInvite(getProfileUserDataPath(), orgInviteRevokeArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'orcaProfiles:orgMemberChangeRole',
    async (
      _event,
      rawArgs: OrcaProfileOrgMemberChangeRoleArgs
    ): Promise<OrcaProfileOrgMemberMutationResult> =>
      changeOrcaProfileOrgMemberRole(
        getProfileUserDataPath(),
        orgMemberChangeRoleArgsFromUnknown(rawArgs)
      )
  )

  ipcMain.handle(
    'orcaProfiles:orgMemberRemove',
    async (
      _event,
      rawArgs: OrcaProfileOrgMemberRemoveArgs
    ): Promise<OrcaProfileOrgMemberMutationResult> =>
      removeOrcaProfileOrgMember(getProfileUserDataPath(), orgMemberRemoveArgsFromUnknown(rawArgs))
  )
}
