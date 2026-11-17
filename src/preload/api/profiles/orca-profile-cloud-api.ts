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
  ConnectCurrentOrcaProfileResult,
  OrcaCloudSignInEnd,
  OrcaCloudSignInProgress
} from '../../../shared/orca-profiles/orca-profiles'
import type {
  OrcaBillingReturn,
  OrcaBillingStatusResult,
  OrcaBillingTeamPlansResult
} from '../../../shared/orca-billing'
import type { OrcaCloudSetupReturn } from '../../../shared/orca-cloud-setup-link'
import type { OrcaPlanCatalogResult } from '../../../shared/orca-billing-plans'

/** Orca Cloud's members of `window.api.orcaProfiles`, on top of the upstream profile API. */
export type OrcaProfileCloudApi<Base> = Omit<Base, 'connectCurrent' | 'onSignInProgressChanged'> & {
  /** `openBrowser: false` starts sign-in without opening the browser. */
  connectCurrent: (args?: { openBrowser?: boolean }) => Promise<ConnectCurrentOrcaProfileResult>
  onSignInProgressChanged: (
    /** `end` says why a sign-in stopped when the UI should tell the user (it timed out). */
    callback: (progress: OrcaCloudSignInProgress | null, end: OrcaCloudSignInEnd | null) => void
  ) => () => void
  /** The signed-in person's own two-factor state and where to manage it. */
  accountMfa: () => Promise<OrcaAccountMfaResult>
  /** The team's "require MFA" policy and the person's own state in it. */
  teamMfaPolicy: (args: OrcaTeamMfaPolicyArgs) => Promise<OrcaTeamMfaPolicyResult>
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
  /** Plan state for other teams the user is on ("Switch to <team>"); never switches teams. */
  billingTeamPlans: (args: { orgIds: string[] }) => Promise<OrcaBillingTeamPlansResult>
}
