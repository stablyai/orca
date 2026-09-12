import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import {
  runtimeExpectsLiveSshRelay,
  type EphemeralVmRuntimeRecord
} from '../shared/ephemeral-vm-runtimes'
import { isRuntimeOwnedSshTargetId } from '../shared/execution-host'
import { forEachWithConcurrency } from '../shared/map-with-concurrency'
import { formatRuntimeOwnedSshRelayReattachFailed } from '../shared/ssh-pty-provider-missing'
import { setSshProviderMissRecovery } from './providers/ssh-provider-miss-recovery'
import {
  getRuntimeOwnedSshRelayState,
  reattachRuntimeOwnedSshTarget,
  runtimeOwnedSshTargetNeedsCredentialPrompt
} from './ephemeral-vm-runtime-ssh'

/**
 * Why bounded like the renderer's startup restore (15 s per eager target): a target that
 * neither connects nor fails would otherwise hold every spawn and activation that joined
 * its in-flight promise. The underlying `ssh.connect` keeps running in main after the
 * timeout, so a later caller can still find the relay attached.
 */
export const RUNTIME_SSH_REATTACH_TIMEOUT_MS = 15_000
/** Why bounded: every record left `running` by a crash is dialed at startup. */
export const RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY = 4

const reattachInFlight = new Map<string, Promise<void>>()

/**
 * Re-attach the relay of every runtime persisted as running whose relay this process
 * does not hold. Runtime-owned targets are excluded from every generic SSH connect path
 * (startup restore, pane connect, the host list), so this is the only thing that
 * dials them after an app restart. Failures are logged, not thrown: the VM may be gone,
 * and the resume/spawn paths retry on demand.
 *
 * Targets whose last connect needed a credential are deferred, exactly as the renderer's
 * startup restore defers them: nothing is listening for the prompt yet, and a dial here
 * would only burn the credential timeout. They re-attach on the first user gesture.
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
  const eager = runtimes.filter((runtime) => {
    if (runtimeOwnedSshTargetNeedsCredentialPrompt(runtime.sshTargetId)) {
      console.warn(
        `[ephemeral-vm] Deferring SSH relay re-attach for runtime ${runtime.id}: it needs a credential prompt.`
      )
      return false
    }
    return true
  })
  await forEachWithConcurrency(eager, RUNTIME_SSH_STARTUP_REATTACH_CONCURRENCY, (runtime) =>
    ensureRuntimeOwnedSshTargetAttached(runtime).catch((error: unknown) => {
      console.warn(
        `[ephemeral-vm] Could not re-attach SSH relay for runtime ${runtime.id} at startup: ${describeError(error)}`
      )
    })
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Serialized per target so a startup pass, a resume, and a spawn share one connect. The
 * shared promise is bounded; the timed-out dial keeps running in main and the entry is
 * cleared so the next caller re-checks the relay state instead of joining a dead wait.
 */
export function ensureRuntimeOwnedSshTargetAttached(
  runtime: EphemeralVmRuntimeRecord & { sshTargetId: string },
  timeoutMs: number = RUNTIME_SSH_REATTACH_TIMEOUT_MS
): Promise<void> {
  if (getRuntimeOwnedSshRelayState(runtime.sshTargetId) === 'attached') {
    return Promise.resolve()
  }
  const existing = reattachInFlight.get(runtime.sshTargetId)
  if (existing) {
    return existing
  }
  const abort = new AbortController()
  const attempt = raceWithTimeout(
    reattachRuntimeOwnedSshTarget(runtime, abort.signal),
    timeoutMs,
    () => {
      abort.abort()
      return new Error(
        `SSH relay for runtime "${runtime.id}" did not attach within ${Math.round(timeoutMs / 1000)}s.`
      )
    }
  ).finally(() => {
    if (reattachInFlight.get(runtime.sshTargetId) === attempt) {
      reattachInFlight.delete(runtime.sshTargetId)
    }
  })
  reattachInFlight.set(runtime.sshTargetId, attempt)
  return attempt
}

function raceWithTimeout(
  work: Promise<void>,
  timeoutMs: number,
  onTimeout: () => Error
): Promise<void> {
  if (!Number.isFinite(timeoutMs)) {
    return work
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs)
  })
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer)
    // Why: the work promise outlives a lost race; its rejection must not become unhandled.
    work.catch(() => undefined)
  })
}

/**
 * Resolve a provider miss (PTY, git, or filesystem) for a runtime-owned target by
 * re-attaching its relay before the operation resolves the provider. Non-runtime ids and
 * runtimes that are not expected to be up return undefined so the ordinary miss stands.
 */
export function installRuntimeOwnedSshProviderMissRecovery(getUserDataPath: () => string): void {
  setSshProviderMissRecovery((connectionId) => {
    if (!isRuntimeOwnedSshTargetId(connectionId)) {
      return undefined
    }
    // Why leave a self-reconnecting relay alone: it re-registers its provider itself, and
    // dialing over it would tear the recovering session down. Waiting for it here would hold
    // the spawn for a bounded-but-unknown time; the ordinary miss (with its retry hint) stands.
    if (getRuntimeOwnedSshRelayState(connectionId) === 'reconnecting') {
      return undefined
    }
    const runtime = listEphemeralVmRuntimes(getUserDataPath()).find(
      (entry) => entry.sshTargetId === connectionId
    )
    if (!runtime || !runtimeExpectsLiveSshRelay(runtime)) {
      return undefined
    }
    // Why rewrap in the provider-miss shape: `orca terminal create` shows it as-is and needs
    // the retry named (runtime-owned targets have no host-list Reconnect); the renderer
    // matches the prefix and re-renders the cause with translated copy and no internal id.
    return ensureRuntimeOwnedSshTargetAttached(runtime).catch((error: unknown) => {
      throw new Error(formatRuntimeOwnedSshRelayReattachFailed(connectionId, describeError(error)))
    })
  })
}
