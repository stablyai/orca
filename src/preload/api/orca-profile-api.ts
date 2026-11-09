import type {
  OrcaProfileOrgCreateArgs,
  OrcaProfileOrgCreateResult,
  OrcaProfileOrgLeaveArgs
} from '../../shared/orca-org-management'
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
} from '../../shared/orca-profiles'
import type {
  OrcaBillingCheckoutArgs,
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingReturn,
  OrcaBillingStatusResult
} from '../../shared/orca-billing'

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
  /** Revokes and re-sends a pending invite with the same role. */
  orgInviteResend: (
    args: OrcaProfileOrgMemberInviteArgs
  ) => Promise<OrcaProfileOrgMemberMutationResult>
  /** Leaves the org as the signed-in user; the last owner is refused. */
  orgLeave: (args: OrcaProfileOrgLeaveArgs) => Promise<OrcaProfileOrgMemberMutationResult>
  /** Creates a team owned by the signed-in user. */
  orgCreate: (args: OrcaProfileOrgCreateArgs) => Promise<OrcaProfileOrgCreateResult>
  /** Fires when the browser comes back from Stripe Checkout or the Portal (orca:// link). */
  onBillingReturn: (callback: (event: OrcaBillingReturn) => void) => () => void
  /** Plan & billing for the signed-in account (Orca Cloud billing service). */
  billingStatus: () => Promise<OrcaBillingStatusResult>
  /** Opens hosted Stripe Checkout in the browser. */
  billingOpenCheckout: (args: OrcaBillingCheckoutArgs) => Promise<OrcaBillingOpenResult>
  /** Opens the Stripe Customer Portal in the browser. */
  billingOpenPortal: () => Promise<OrcaBillingOpenResult>
  /** Opt in/out of sandbox overage and set the monthly spend cap (org admins). */
  billingSetOverage: (args: OrcaBillingOverageArgs) => Promise<OrcaBillingOverageResult>
}
