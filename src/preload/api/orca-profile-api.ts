import type {
  CloudSetupGetResult,
  CloudSetupLinkResult,
  CloudSetupStartArgs,
  CloudSetupStartResult
} from '../../shared/orca-cloud-setup'
import type {
  OrcaProfileOrgDeleteArgs,
  OrcaProfileOrgDeleteCheckArgs,
  OrcaProfileOrgDeleteCheckResult,
  OrcaProfileOrgDeleteResult
} from '../../shared/orca-org-delete'
import type {
  OrcaProfileOrgCreateArgs,
  OrcaProfileOrgCreateResult,
  OrcaProfileOrgLeaveArgs
} from '../../shared/orca-org-management'
import type {
  OrcaCloudSignInEnd,
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
  OrcaBillingTrialClaimResult,
  OrcaBillingReturn,
  OrcaBillingStatusResult,
  OrcaBillingTeamPlansResult,
  OrcaBillingUsageHistoryResult
} from '../../shared/orca-billing'
import type { OrcaCloudSetupReturn } from '../../shared/orca-cloud-setup-link'
import type { OrcaPlanCatalogResult } from '../../shared/orca-billing-plans'

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
    /** `end` says why a sign-in stopped when the UI should tell the user (it timed out). */
    callback: (progress: OrcaCloudSignInProgress | null, end: OrcaCloudSignInEnd | null) => void
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
  /** Whether an owner can delete the team now, and what blocks it (TEAM-DELETE). */
  orgDeleteCheck: (args: OrcaProfileOrgDeleteCheckArgs) => Promise<OrcaProfileOrgDeleteCheckResult>
  /** Deletes the team for everyone; `confirmName` is the name exactly as typed. */
  orgDelete: (args: OrcaProfileOrgDeleteArgs) => Promise<OrcaProfileOrgDeleteResult>
  /** Fires when the browser comes back from Stripe Checkout or the Portal (orca:// link). */
  onBillingReturn: (callback: (event: OrcaBillingReturn) => void) => () => void
  /** Main asks for a billing re-read (cloud workspace created/woken, or the usage poll). */
  onBillingRefreshRequested: (callback: () => void) => () => void
  /** Fires when the setup done page opens orca://cloud/setup/return?session=… (N9). */
  onCloudSetupReturn: (callback: (event: OrcaCloudSetupReturn) => void) => () => void
  /** Plan & billing for the signed-in account (Orca Cloud billing service). */
  billingStatus: () => Promise<OrcaBillingStatusResult>
  /** Billing's public plan catalog: prices (Stripe's), features, seat bounds. */
  billingPlans: () => Promise<OrcaPlanCatalogResult>
  /** Opens hosted Stripe Checkout in the browser. */
  billingOpenCheckout: (args: OrcaBillingCheckoutArgs) => Promise<OrcaBillingOpenResult>
  /** Starts Orca Cloud setup: one browser tab for sign-in, team, plan and GitHub. */
  cloudSetupStart: (args: CloudSetupStartArgs) => Promise<CloudSetupStartResult>
  /** The setup session's steps, for the composer's setup panel. */
  cloudSetupGet: (args: { sessionId: string }) => Promise<CloudSetupGetResult>
  /** "Copy setup link": a fresh one-time link to the same setup session. */
  cloudSetupLink: (args: { sessionId: string }) => Promise<CloudSetupLinkResult>
  /** Opens the Stripe Customer Portal in the browser. */
  billingOpenPortal: () => Promise<OrcaBillingOpenResult>
  /** The last 30 days of sandbox hours (breakdowns for owners and admins only). */
  billingUsageHistory: (args: {
    utcOffsetMinutes: number
  }) => Promise<OrcaBillingUsageHistoryResult>
  /** Plan state for other teams the user is on ("Switch to <team>"); never switches teams. */
  billingTeamPlans: (args: { orgIds: string[] }) => Promise<OrcaBillingTeamPlansResult>
  /** Opt in/out of sandbox overage and set the monthly spend cap (org admins). */
  billingSetOverage: (args: OrcaBillingOverageArgs) => Promise<OrcaBillingOverageResult>
  /** Starts the team's one-time Orca Cloud trial (idempotent; no card). */
  billingClaimTrial: () => Promise<OrcaBillingTrialClaimResult>
}
