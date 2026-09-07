import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import {
  runtimeExpectsLiveSshRelay,
  type EphemeralVmRuntimeRecord
} from '../shared/ephemeral-vm-runtimes'
import { isRuntimeOwnedSshTargetId } from '../shared/execution-host'
import { setMissingSshPtyProviderRecovery } from './ipc/pty/provider/missing-ssh-pty-provider-recovery'
import {
  getRuntimeOwnedSshRelayState,
  reattachRuntimeOwnedSshTarget
} from './ephemeral-vm-runtime-ssh'

const reattachInFlight = new Map<string, Promise<void>>()

/**
 * Re-attach the relay of every runtime persisted as running whose relay this process
 * does not hold. Runtime-owned targets are excluded from every generic SSH connect path
 * (startup restore, pane connect, the host list), so this is the only thing that
 * dials them after an app restart. Failures are logged, not thrown: the VM may be gone,
 * and the resume/spawn paths retry on demand.
 */
export async function reattachRuntimeOwnedSshTargetsAtStartup(
  getUserDataPath: () => string
): Promise<void> {
  let runtimes: (EphemeralVmRuntimeRecord & { sshTargetId: string })[]
  try {
    runtimes = listEphemeralVmRuntimes(getUserDataPath()).filter(runtimeExpectsLiveSshRelay)
  } catch (error) {
    console.warn(`[ephemeral-vm] Skipping SSH relay re-attach at startup: ${describeError(error)}`)
    return
  }
  await Promise.all(
    runtimes.map((runtime) =>
      ensureRuntimeOwnedSshTargetAttached(runtime).catch((error: unknown) => {
        console.warn(
          `[ephemeral-vm] Could not re-attach SSH relay for runtime ${runtime.id} at startup: ${describeError(error)}`
        )
      })
    )
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Serialized per target so a startup pass, a resume, and a spawn share one connect. */
export function ensureRuntimeOwnedSshTargetAttached(
  runtime: EphemeralVmRuntimeRecord & { sshTargetId: string }
): Promise<void> {
  if (getRuntimeOwnedSshRelayState(runtime.sshTargetId) === 'attached') {
    return Promise.resolve()
  }
  const existing = reattachInFlight.get(runtime.sshTargetId)
  if (existing) {
    return existing
  }
  const attempt = reattachRuntimeOwnedSshTarget(runtime).finally(() => {
    if (reattachInFlight.get(runtime.sshTargetId) === attempt) {
      reattachInFlight.delete(runtime.sshTargetId)
    }
  })
  reattachInFlight.set(runtime.sshTargetId, attempt)
  return attempt
}

/**
 * Resolve a PTY-provider miss for a runtime-owned target by re-attaching its relay
 * before the spawn resolves the provider. Non-runtime ids and runtimes that are not
 * expected to be up return undefined so the ordinary "No PTY provider" path stands.
 */
export function installRuntimeOwnedSshPtyProviderRecovery(getUserDataPath: () => string): void {
  setMissingSshPtyProviderRecovery((connectionId) => {
    if (!isRuntimeOwnedSshTargetId(connectionId)) {
      return undefined
    }
    // Why leave a self-reconnecting relay alone: it re-registers its provider itself, and
    // dialing over it would tear the recovering session down.
    if (getRuntimeOwnedSshRelayState(connectionId) === 'reconnecting') {
      return undefined
    }
    const runtime = listEphemeralVmRuntimes(getUserDataPath()).find(
      (entry) => entry.sshTargetId === connectionId
    )
    if (!runtime || !runtimeExpectsLiveSshRelay(runtime)) {
      return undefined
    }
    // Why rewrap: this message reaches the terminal as-is, and the bare connect error does
    // not say which retry the user has (runtime-owned targets have no host-list Reconnect).
    return ensureRuntimeOwnedSshTargetAttached(runtime).catch((error: unknown) => {
      throw new Error(
        `Could not re-attach the SSH relay for this workspace: ${describeError(error)} ` +
          'Open the workspace again or start a new terminal to retry.'
      )
    })
  })
}
