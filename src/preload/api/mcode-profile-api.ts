import type {
  ConnectCurrentMCodeProfileResult,
  CreateCloudLinkedMCodeProfileArgs,
  CreateCloudLinkedMCodeProfileResult,
  CreateLocalMCodeProfileArgs,
  CreateLocalMCodeProfileResult,
  FindMCodeProfileProjectsByPathArgs,
  FindMCodeProfileProjectsByPathResult,
  MCodeProfileAuthStatus,
  MCodeProfileListResult,
  MCodeProfileOrgInviteRevokeArgs,
  MCodeProfileOrgMemberChangeRoleArgs,
  MCodeProfileOrgMemberInviteArgs,
  MCodeProfileOrgMemberMutationResult,
  MCodeProfileOrgMemberRemoveArgs,
  MCodeProfileOrgMembersListArgs,
  MCodeProfileOrgMembersListResult,
  RefreshCurrentMCodeProfileAuthResult,
  SelectMCodeProfileOrgArgs,
  SelectMCodeProfileOrgResult,
  SignOutCurrentMCodeProfileResult,
  SwitchMCodeProfileArgs,
  SwitchMCodeProfileResult,
  TransferMCodeProfileProjectArgs,
  TransferMCodeProfileProjectResult
} from '../../shared/mcode-profiles'

export type MCodeProfileApi = {
  list: () => Promise<MCodeProfileListResult>
  authStatus: () => Promise<MCodeProfileAuthStatus>
  createLocal: (args?: CreateLocalMCodeProfileArgs) => Promise<CreateLocalMCodeProfileResult>
  createCloudLinked: (
    args?: CreateCloudLinkedMCodeProfileArgs
  ) => Promise<CreateCloudLinkedMCodeProfileResult>
  switchProfile: (args: SwitchMCodeProfileArgs) => Promise<SwitchMCodeProfileResult>
  transferProject: (
    args: TransferMCodeProfileProjectArgs
  ) => Promise<TransferMCodeProfileProjectResult>
  findProjectProfiles: (
    args: FindMCodeProfileProjectsByPathArgs
  ) => Promise<FindMCodeProfileProjectsByPathResult>
  connectCurrent: () => Promise<ConnectCurrentMCodeProfileResult>
  refreshAuth: () => Promise<RefreshCurrentMCodeProfileAuthResult>
  signOutCurrent: () => Promise<SignOutCurrentMCodeProfileResult>
  selectOrg: (args: SelectMCodeProfileOrgArgs) => Promise<SelectMCodeProfileOrgResult>
  orgMembersList: (args: MCodeProfileOrgMembersListArgs) => Promise<MCodeProfileOrgMembersListResult>
  orgMemberInvite: (
    args: MCodeProfileOrgMemberInviteArgs
  ) => Promise<MCodeProfileOrgMemberMutationResult>
  orgInviteRevoke: (
    args: MCodeProfileOrgInviteRevokeArgs
  ) => Promise<MCodeProfileOrgMemberMutationResult>
  orgMemberChangeRole: (
    args: MCodeProfileOrgMemberChangeRoleArgs
  ) => Promise<MCodeProfileOrgMemberMutationResult>
  orgMemberRemove: (
    args: MCodeProfileOrgMemberRemoveArgs
  ) => Promise<MCodeProfileOrgMemberMutationResult>
}
