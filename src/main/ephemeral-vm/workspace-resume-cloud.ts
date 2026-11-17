// Orca Cloud's part of a recipe VM wake (workspace-resume.ts): a VM slept elsewhere, an archived
// workspace's refused resume, quiet wakes on intent, and the control socket pre-connected while a
// hosted VM boots so the wake costs one connection setup.
import type { EphemeralVmRuntimeRecord } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtimes'
import { findWorkspaceEphemeralVmRuntime } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-workspace-runtime'
import { updateEphemeralVmRuntimeStatus } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairedRuntimeConnection } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { CLOUD_WORKSPACE_ARCHIVED_ERROR } from '../../shared/hosted-sandbox/cloud-workspace-api'
import { isCloudWorkspaceArchivedOnControlPlane } from '../hosted-sandbox/hosted-workspace-runtime'
import {
  isCloudWorkspaceAsleepOnControlPlane,
  markCloudRuntimeSleptElsewhere
} from '../hosted-sandbox/hosted-remote-sleep'
import { ensureRemoteRuntimeSharedControlConnection } from '../ipc/runtime-environments/connections/runtime-environment-request-connections'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/connectivity/runtime-environment-manual-disconnect'
import { getRecipeVmWaker } from '../runtime/workspaces/sleep/recipe-vm-waker-registry'
import { isQuietWake, noteQuietWakeResumed } from './quiet-wakes'
import { noteRecipeVmWakePairing } from './recipe-vm-wake-pairings'
import { probeSavedPairing } from './runtime-resume-pairing'
import {
  preconnectWokenServer,
  proveSavedPairingViaControl,
  waitForWokenControl
} from './woken-server-control'

function isOrcaCloud(runtime: EphemeralVmRuntimeRecord): boolean {
  return runtime.recipe?.provider === 'orca-cloud'
}

/** Slept from the CLI, the phone or another window: the record still says running, and the
 *  control plane says otherwise. Resume it now instead of waiting minutes for lost contact. */
export async function withCloudSleptElsewhere(
  userDataPath: string,
  workspaceId: string,
  found: EphemeralVmRuntimeRecord
): Promise<EphemeralVmRuntimeRecord> {
  return found.status === 'running' &&
    isOrcaCloud(found) &&
    (await isCloudWorkspaceAsleepOnControlPlane(workspaceId).catch(() => false))
    ? (markCloudRuntimeSleptElsewhere(userDataPath, found) ?? found)
    : found
}

/** An archived Orca Cloud workspace is browsed from its archive; only Unarchive wakes it, so a
 *  stale window (or a cold start before its status loaded) can never wake it by opening it. The
 *  control plane refuses to resume an archive, so the check runs alongside the resume instead of
 *  adding a round trip in front of every wake; it only names the refusal. */
export function startCloudArchivedCheck(
  runtime: EphemeralVmRuntimeRecord,
  workspaceId: string
): Promise<boolean> | null {
  return isOrcaCloud(runtime)
    ? isCloudWorkspaceArchivedOnControlPlane(workspaceId).catch(() => false)
    : null
}

export type WokenServerReopenOptions = {
  preopenSharedControl?: boolean
  wakeStartedAt?: number
}

/** Starts a wake's cloud side (pre-connect) and returns the hooks the resume calls at each step. */
export function startCloudWake(
  userDataPath: string,
  workspaceId: string,
  runtime: EphemeralVmRuntimeRecord,
  lostContact: boolean,
  archivedCheck: Promise<boolean> | null
) {
  const wakeStartedAt = Date.now()
  // Hosted VMs keep their server endpoint across a stop, so the control socket can dial from the
  // saved pairing while the VM boots and connect the moment its server listens.
  const preconnectEnvironmentId =
    isOrcaCloud(runtime) &&
    runtime.connectionMode === 'orca-server' &&
    runtime.runtimeEnvironmentId &&
    // A lost-contact recovery may still reach the old boot; only a clean wake pre-connects.
    !lostContact &&
    !isRuntimeEnvironmentManuallyDisconnected(runtime.runtimeEnvironmentId)
      ? runtime.runtimeEnvironmentId
      : null
  const stopPreconnect = preconnectEnvironmentId
    ? preconnectWokenServer(userDataPath, preconnectEnvironmentId, () => {
        // Only while this wake is still on: a sleep or a failed wake leaves the record asleep.
        const current = findWorkspaceEphemeralVmRuntime(userDataPath, workspaceId)
        return (
          current?.status === 'running' || getRecipeVmWaker()?.state(workspaceId, true) === 'waking'
        )
      })
    : () => {}
  return {
    /** The recipe's resume threw: stop the pre-connect. */
    stopAndRethrow: (error: unknown): never => {
      stopPreconnect()
      throw error
    },
    /** After a failed resume restored the record: a quiet wake saves no failure, an archive throws. */
    failed: async (): Promise<void> => {
      stopPreconnect()
      if (isQuietWake(workspaceId)) {
        // A wake on intent that nobody opened: no failed resume is saved for the row to show.
        updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
          status: runtime.status,
          lifecycleLastError: null
        })
      }
      if (archivedCheck && (await archivedCheck)) {
        // Not a failed resume: the workspace is archived. Leave the record as it was.
        updateEphemeralVmRuntimeStatus(userDataPath, runtime.id, {
          status: runtime.status,
          lifecycleLastError: null
        })
        throw new Error(CLOUD_WORKSPACE_ARCHIVED_ERROR)
      }
    },
    /** The VM really resumed (not an early return on a VM already up): a quiet wake may count it. */
    resumed: (): void => noteQuietWakeResumed(workspaceId),
    pairingOptions: {
      // The wake's own reconnect proves the kept token; a separate probe first would put one more
      // connection setup between the click and the terminal.
      confirmInBackground: true,
      // A pre-connected control socket that authenticated against the woken server already proved
      // the kept token: one handshake per wake. Only without it does the standalone probe run.
      ...(preconnectEnvironmentId
        ? {
            probeSavedPairing: (pairedConnection: PairedRuntimeConnection) =>
              proveSavedPairingViaControl(preconnectEnvironmentId, wakeStartedAt, () =>
                probeSavedPairing(pairedConnection)
              )
          }
        : {}),
      onRepairedInBackground: (repaired: KnownRuntimeEnvironment) =>
        noteRecipeVmWakePairing(repaired.id, repaired.pairingRevision ?? repaired.createdAt, true)
    },
    reopen: {
      // A hosted VM always runs a shared-control server, so its control socket can dial alongside
      // the health probe instead of after the probe confirms the capability (one setup saved).
      preopenSharedControl: isOrcaCloud(runtime),
      wakeStartedAt
    } satisfies WokenServerReopenOptions
  }
}

/** A hosted wake dials its control socket right away instead of waiting on the health probe. */
export async function preopenWokenSharedControl(
  userDataPath: string,
  environmentId: string,
  options: WokenServerReopenOptions
): Promise<void> {
  if (options.preopenSharedControl) {
    ensureRemoteRuntimeSharedControlConnection(
      environmentId,
      getPreferredPairedRuntimeConnection(await resolveEnvironment(userDataPath, environmentId))
    )
  }
}

/** Runs the woken server's status refresh (best effort), riding a pre-opened control socket. */
export function refreshAfterWokenControl(
  environmentId: string,
  options: WokenServerReopenOptions,
  refresh: () => Promise<void>
): void {
  const refreshStatus = async (): Promise<void> => {
    try {
      await refresh()
    } catch {
      // The status owner reports its own failures; this reopen is best effort.
    }
  }
  if (options.preopenSharedControl && options.wakeStartedAt !== undefined) {
    // Ride the control socket once it is up (one handshake) rather than open a second one.
    void waitForWokenControl(environmentId, options.wakeStartedAt).then(
      refreshStatus,
      refreshStatus
    )
  } else {
    void refreshStatus()
  }
}
