// Orca Cloud's members of the preload `ephemeralVm` API, layered onto the upstream recipe VM API:
// cloud-only methods, plus the extra fields cloud passes to (or reads from) three upstream methods.
import type { CloudCreateRendererPhase } from '../../../shared/orca-cloud/cloud-create-phases'
import type { OrcaCloudAvailability } from '../../../shared/workspace-setup/orca-yaml-hook-types'
import type {
  HostedSessionIdleSleepEvent,
  HostedSessionRestartResult,
  HostedSessionStateEvent,
  HostedSessionWarningEvent
} from '../../../shared/hosted-sandbox/hosted-session-events'
import type {
  CloudSshCopyResult,
  CloudSshOpenEditorRequest,
  CloudSshOpenEditorResult,
  CloudSshRevokeResult,
  CloudSshStatus
} from '../../../shared/cloud-ssh'
import type { CloudRemoteDesktopResult } from '../../../shared/hosted-sandbox/cloud-remote-desktop'
import type { RecipeForwardedEnvSummary } from '../../../shared/ephemeral-vm-recipe-forwarded-env'

/** The upstream methods whose arguments or result Orca Cloud extends. */
type ExtendedUpstreamMethods = {
  listRecipes: (args: { repoId: string }) => Promise<object>
  provision: (args: { repoId: string; recipeId: string }) => Promise<unknown>
  resumeWorkspace: (args: { workspaceId: string }) => Promise<unknown>
}

/** The upstream `EphemeralVmApi` shape with Orca Cloud's members and extensions applied. */
export type EphemeralVmCloudApi<Api extends ExtendedUpstreamMethods> = Omit<
  Api,
  keyof ExtendedUpstreamMethods
> &
  EphemeralVmCloudMembers & {
    listRecipes: (args: Parameters<Api['listRecipes']>[0]) => Promise<
      Awaited<ReturnType<Api['listRecipes']>> & {
        /** Absent from older mains and web clients; treat as unavailable. */
        orcaCloud?: OrcaCloudAvailability
      }
    >
    provision: (
      args: Parameters<Api['provision']>[0] & {
        /** Orca Cloud: one per Create press, sent as the create's Idempotency-Key. */
        idempotencyKey?: string
      }
    ) => ReturnType<Api['provision']>
    /** `quiet`: a wake started on intent; a refusal leaves the VM record as it was. */
    resumeWorkspace: (
      args: Parameters<Api['resumeWorkspace']>[0] & {
        quiet?: boolean
        /** Only mark the workspace opened (claims an intent wake); wakes nothing. */
        claimOnly?: boolean
      }
    ) => ReturnType<Api['resumeWorkspace']>
  }

type EphemeralVmCloudMembers = {
  /**
   * Names (never values) of this computer's env that recipe scripts receive. Given a recipe host's
   * environmentId, main applies that recipe's passEnv; otherwise the whole env.
   */
  forwardedEnvSummary: (args?: { environmentId?: string }) => Promise<RecipeForwardedEnvSummary>
  /** The renderer's create phases after the provision, logged by main with the create's timing. */
  notePhase?: (args: { provisionId: string; phase: CloudCreateRendererPhase }) => void
  /** Orca Cloud: the session nears its cap (60/15/5 min left); running agents resume after the restart. */
  onCloudSessionWarning: (callback: (event: HostedSessionWarningEvent) => void) => () => void
  /** Orca Cloud: the workspace has been idle long enough to sleep through the ordinary Sleep flow. */
  onCloudIdleSleepRequested: (callback: (event: HostedSessionIdleSleepEvent) => void) => () => void
  /** Orca Cloud: a session rollover is restarting the workspace's machine, or it is back. */
  onCloudSessionState: (callback: (event: HostedSessionStateEvent) => void) => () => void
  /** Orca Cloud: roll the workspace's session over now instead of at the cap. */
  restartCloudSession: (args: { workspaceId: string }) => Promise<HostedSessionRestartResult>
  /** Orca Cloud: runtime environment ids that are Orca Cloud VMs. Absent in the web client. */
  cloudEnvironmentIds?: () => Promise<string[]>
  /** Orca Cloud: starts the VM's desktop and forwards it to this computer's localhost. */
  openCloudRemoteDesktop?: (args: { environmentId: string }) => Promise<CloudRemoteDesktopResult>
  /**
   * Orca Cloud: puts a sandbox that never became a workspace to sleep (a create blocked on a
   * failed environment check). Optional: the web client has no VM lifecycle.
   */
  suspendRuntime?: (args: { runtimeId: string }) => Promise<{ ok: boolean; error?: string }>
  /** Orca Cloud: before Delete drops the row, prove the signed-in identity can reach the sandbox. */
  preflightCloudDelete?: (args: {
    runtimeEnvironmentId: string
  }) => Promise<
    | { ok: true; asleep?: boolean; gone?: boolean; unreachable?: 'rejected' | 'no_answer' }
    | { ok: false; error: string; errorCode?: string }
  >
  /** Orca Cloud SSH: whether it applies to a workspace, and which editors can open it. */
  cloudSshStatus: (args: { workspaceId: string }) => Promise<CloudSshStatus>
  /** Ensures access (waking only for the first key install) and copies the ssh command. */
  cloudSshCopyCommand: (args: { workspaceId: string }) => Promise<CloudSshCopyResult>
  cloudSshOpenInEditor: (args: CloudSshOpenEditorRequest) => Promise<CloudSshOpenEditorResult>
  cloudSshRevoke: (args: { workspaceId: string }) => Promise<CloudSshRevokeResult>
  /** Takes Orca's Include line back out of ~/.ssh/config. */
  cloudSshRemoveSshConfigInclude: () => Promise<boolean>
}
