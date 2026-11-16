import type {
  OrcaTeamMfaPolicyArgs,
  OrcaTeamMfaPolicyResult
} from '../../../shared/orca-team-mfa-policy'
import type {
  OrcaCloudConsoleOpenArgs,
  OrcaCloudConsoleOpenResult
} from '../../../shared/orca-cloud-console'
import type { OrcaAccountMfaResult } from '../../../shared/orca-account-mfa'
import type {
  CloudSetupGetResult,
  CloudSetupLinkResult,
  CloudSetupStartArgs,
  CloudSetupStartResult
} from '../../../shared/orca-cloud-setup'
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
  OrcaBillingOpenResult,
  OrcaBillingOverageArgs,
  OrcaBillingOverageResult,
  OrcaBillingTrialClaimResult,
  OrcaBillingReturn,
  OrcaBillingStatusResult,
  OrcaBillingTeamPlansResult
} from '../../../shared/orca-billing'
import type { OrcaCloudSetupReturn } from '../../../shared/orca-cloud-setup-link'
import type { OrcaPlanCatalogResult } from '../../../shared/orca-billing-plans'

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
  /** `openBrowser: false` starts sign-in without opening the browser. */
  connectCurrent: (args?: { openBrowser?: boolean }) => Promise<ConnectCurrentOrcaProfileResult>
  signInProgress: () => Promise<OrcaCloudSignInProgress | null>
  onSignInProgressChanged: (
    /** `end` says why a sign-in stopped when the UI should tell the user (it timed out). */
    callback: (progress: OrcaCloudSignInProgress | null, end: OrcaCloudSignInEnd | null) => void
  ) => () => void
  cancelSignIn: () => Promise<void>
  refreshAuth: () => Promise<RefreshCurrentOrcaProfileAuthResult>
  signOutCurrent: () => Promise<SignOutCurrentOrcaProfileResult>
  selectOrg: (args: SelectOrcaProfileOrgArgs) => Promise<SelectOrcaProfileOrgResult>
  /** The signed-in person's own two-factor state and where to manage it. */
  accountMfa: () => Promise<OrcaAccountMfaResult>
  /** The team's "require MFA" policy and the person's own state in it. */
  teamMfaPolicy: (args: OrcaTeamMfaPolicyArgs) => Promise<OrcaTeamMfaPolicyResult>
  orgMembersList: (args: OrcaProfileOrgMembersListArgs) => Promise<OrcaProfileOrgMembersListResult>
  /**
   * Opens a web console page (team, billing, Enterprise) in the system browser, signed in with a
   * single-use code when auth gives one.
   */
  openCloudConsole: (args: OrcaCloudConsoleOpenArgs) => Promise<OrcaCloudConsoleOpenResult>
  /** Fires when the browser comes back from Stripe Checkout or the Portal (orca:// link). */
  onBillingReturn: (callback: (event: OrcaBillingReturn) => void) => () => void
  /** Main asks for a billing re-read (cloud workspace created/woken, or the usage poll). */
  onBillingRefreshRequested: (callback: () => void) => () => void
  /** Fires when the setup done page opens orca://cloud/setup/return?session=…. */
  onCloudSetupReturn: (callback: (event: OrcaCloudSetupReturn) => void) => () => void
  /** Plan & billing for the signed-in account (Orca Cloud billing service). */
  billingStatus: () => Promise<OrcaBillingStatusResult>
  /** Billing's public plan catalog: prices (Stripe's), features, seat bounds. */
  billingPlans: () => Promise<OrcaPlanCatalogResult>
  /** Starts Orca Cloud setup: one browser tab for sign-in, team, plan and GitHub. */
  cloudSetupStart: (args: CloudSetupStartArgs) => Promise<CloudSetupStartResult>
  /** The setup session's steps, for the composer's setup panel. */
  cloudSetupGet: (args: { sessionId: string }) => Promise<CloudSetupGetResult>
  /** "Copy setup link": a fresh one-time link to the same setup session. */
  cloudSetupLink: (args: { sessionId: string }) => Promise<CloudSetupLinkResult>
  /** Opens the Stripe Customer Portal in the browser. */
  billingOpenPortal: () => Promise<OrcaBillingOpenResult>
  /** Plan state for other teams the user is on ("Switch to <team>"); never switches teams. */
  billingTeamPlans: (args: { orgIds: string[] }) => Promise<OrcaBillingTeamPlansResult>
  /** Opt in/out of sandbox overage and set the monthly spend cap (org admins). */
  billingSetOverage: (args: OrcaBillingOverageArgs) => Promise<OrcaBillingOverageResult>
  /** Starts the team's one-time Orca Cloud trial (idempotent; no card). */
  billingClaimTrial: () => Promise<OrcaBillingTrialClaimResult>
}
