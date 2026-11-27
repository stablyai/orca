import type {
  OrcaCloudSignInProgress,
  ConnectCurrentOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  CreateLocalOrcaProfileArgs,
  CreateLocalOrcaProfileResult,
  FindOrcaProfileProjectsByPathArgs,
  FindOrcaProfileProjectsByPathResult,
  OrcaProfileAuthStatus,
  OrcaProfileListResult,
  OrcaProfileOrgInviteRevokeArgs,
  OrcaProfileOrgMemberChangeRoleArgs,
  OrcaProfileOrgMemberInviteArgs,
  OrcaProfileOrgMemberMutationResult,
  OrcaProfileOrgMemberRemoveArgs,
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgArgs,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult,
  SwitchOrcaProfileArgs,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult
} from '../../../shared/orca-profiles/orca-profiles'
import type {
  OrcaCloudConsoleOpenArgs,
  OrcaCloudConsoleOpenResult
} from '../../../shared/orca-cloud-console'

export type OrcaProfileApi = {
  list: () => Promise<OrcaProfileListResult>
  authStatus: () => Promise<OrcaProfileAuthStatus>
  /** Fires when main changed the stored auth status on its own (e.g. a revoked session). */
  onAuthStatusChanged: (callback: () => void) => () => void
  createLocal: (args?: CreateLocalOrcaProfileArgs) => Promise<CreateLocalOrcaProfileResult>
  createCloudLinked: (
    args?: CreateCloudLinkedOrcaProfileArgs
  ) => Promise<CreateCloudLinkedOrcaProfileResult>
  switchProfile: (args: SwitchOrcaProfileArgs) => Promise<SwitchOrcaProfileResult>
  transferProject: (
    args: TransferOrcaProfileProjectArgs
  ) => Promise<TransferOrcaProfileProjectResult>
  findProjectProfiles: (
    args: FindOrcaProfileProjectsByPathArgs
  ) => Promise<FindOrcaProfileProjectsByPathResult>
  connectCurrent: () => Promise<ConnectCurrentOrcaProfileResult>
  signInProgress: () => Promise<OrcaCloudSignInProgress | null>
  onSignInProgressChanged: (
    callback: (progress: OrcaCloudSignInProgress | null) => void
  ) => () => void
  cancelSignIn: () => Promise<void>
  refreshAuth: () => Promise<RefreshCurrentOrcaProfileAuthResult>
  signOutCurrent: () => Promise<SignOutCurrentOrcaProfileResult>
  selectOrg: (args: SelectOrcaProfileOrgArgs) => Promise<SelectOrcaProfileOrgResult>
  orgMembersList: (args: OrcaProfileOrgMembersListArgs) => Promise<OrcaProfileOrgMembersListResult>
  orgMemberInvite: (
    args: OrcaProfileOrgMemberInviteArgs
  ) => Promise<OrcaProfileOrgMemberMutationResult>
  orgInviteRevoke: (
    args: OrcaProfileOrgInviteRevokeArgs
  ) => Promise<OrcaProfileOrgMemberMutationResult>
  orgMemberChangeRole: (
    args: OrcaProfileOrgMemberChangeRoleArgs
  ) => Promise<OrcaProfileOrgMemberMutationResult>
  orgMemberRemove: (
    args: OrcaProfileOrgMemberRemoveArgs
  ) => Promise<OrcaProfileOrgMemberMutationResult>
  /** Opens a web console page in the system browser, signed in when auth issues a ticket. */
  openCloudConsole: (args: OrcaCloudConsoleOpenArgs) => Promise<OrcaCloudConsoleOpenResult>
}
