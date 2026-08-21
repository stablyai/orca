import { ipcMain } from 'electron'
import type {
  MCodeOrgRole,
  MCodeProfileOrgInviteRevokeArgs,
  MCodeProfileOrgMemberChangeRoleArgs,
  MCodeProfileOrgMemberInviteArgs,
  MCodeProfileOrgMemberMutationResult,
  MCodeProfileOrgMemberRemoveArgs,
  MCodeProfileOrgMembersListArgs,
  MCodeProfileOrgMembersListResult
} from '../../shared/mcode-profiles'
import { getProfileUserDataPath } from '../mcode-profiles/profile-storage-paths'
import {
  changeMCodeProfileOrgMemberRole,
  inviteMCodeProfileOrgMember,
  listMCodeProfileOrgMembers,
  removeMCodeProfileOrgMember,
  revokeMCodeProfileOrgInvite
} from '../mcode-profiles/profile-cloud-org-members-service'

function orgMembersScopedArgs(args: unknown): { orgId: string; record: Record<string, unknown> } {
  if (!args || typeof args !== 'object') {
    throw new Error('invalid_mcode_profile_org_selection')
  }
  const record = args as Record<string, unknown>
  const orgId = typeof record.orgId === 'string' ? record.orgId.trim() : ''
  if (!orgId) {
    throw new Error('invalid_mcode_profile_org_selection')
  }
  return { orgId, record }
}

function orgRoleFromUnknown(value: unknown): MCodeOrgRole {
  if (value === 'owner' || value === 'admin' || value === 'member') {
    return value
  }
  throw new Error('invalid_mcode_org_role')
}

function orgEmailFromUnknown(value: unknown): string {
  const email = typeof value === 'string' ? value.trim() : ''
  if (!email) {
    throw new Error('invalid_mcode_org_member_email')
  }
  return email
}

function orgUserIdFromUnknown(value: unknown): string {
  const userId = typeof value === 'string' ? value.trim() : ''
  if (!userId) {
    throw new Error('invalid_mcode_org_member_user')
  }
  return userId
}

function orgMemberInviteArgsFromUnknown(args: unknown): MCodeProfileOrgMemberInviteArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email), role: orgRoleFromUnknown(record.role) }
}

function orgInviteRevokeArgsFromUnknown(args: unknown): MCodeProfileOrgInviteRevokeArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, email: orgEmailFromUnknown(record.email) }
}

function orgMemberChangeRoleArgsFromUnknown(args: unknown): MCodeProfileOrgMemberChangeRoleArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return {
    orgId,
    userId: orgUserIdFromUnknown(record.userId),
    role: orgRoleFromUnknown(record.role)
  }
}

function orgMemberRemoveArgsFromUnknown(args: unknown): MCodeProfileOrgMemberRemoveArgs {
  const { orgId, record } = orgMembersScopedArgs(args)
  return { orgId, userId: orgUserIdFromUnknown(record.userId) }
}

export function registerMCodeProfileOrgMemberHandlers(): void {
  ipcMain.handle(
    'mcodeProfiles:orgMembersList',
    async (
      _event,
      rawArgs: MCodeProfileOrgMembersListArgs
    ): Promise<MCodeProfileOrgMembersListResult> =>
      listMCodeProfileOrgMembers(getProfileUserDataPath(), orgMembersScopedArgs(rawArgs).orgId)
  )

  ipcMain.handle(
    'mcodeProfiles:orgMemberInvite',
    async (
      _event,
      rawArgs: MCodeProfileOrgMemberInviteArgs
    ): Promise<MCodeProfileOrgMemberMutationResult> =>
      inviteMCodeProfileOrgMember(getProfileUserDataPath(), orgMemberInviteArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'mcodeProfiles:orgInviteRevoke',
    async (
      _event,
      rawArgs: MCodeProfileOrgInviteRevokeArgs
    ): Promise<MCodeProfileOrgMemberMutationResult> =>
      revokeMCodeProfileOrgInvite(getProfileUserDataPath(), orgInviteRevokeArgsFromUnknown(rawArgs))
  )

  ipcMain.handle(
    'mcodeProfiles:orgMemberChangeRole',
    async (
      _event,
      rawArgs: MCodeProfileOrgMemberChangeRoleArgs
    ): Promise<MCodeProfileOrgMemberMutationResult> =>
      changeMCodeProfileOrgMemberRole(
        getProfileUserDataPath(),
        orgMemberChangeRoleArgsFromUnknown(rawArgs)
      )
  )

  ipcMain.handle(
    'mcodeProfiles:orgMemberRemove',
    async (
      _event,
      rawArgs: MCodeProfileOrgMemberRemoveArgs
    ): Promise<MCodeProfileOrgMemberMutationResult> =>
      removeMCodeProfileOrgMember(getProfileUserDataPath(), orgMemberRemoveArgsFromUnknown(rawArgs))
  )
}
