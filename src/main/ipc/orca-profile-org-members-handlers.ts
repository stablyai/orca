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
} from '../../shared/orca-profiles'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import {
  changeOrcaProfileOrgMemberRole,
  inviteOrcaProfileOrgMember,
  listOrcaProfileOrgMembers,
  removeOrcaProfileOrgMember,
  revokeOrcaProfileOrgInvite
} from '../orca-profiles/profile-cloud-org-members-service'

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

export function registerOrcaProfileOrgMemberHandlers(): void {
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
