import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { getSshPtyProvider } from './ipc/pty/provider/registry'
import { connectRegisteredSshTarget, getSshConnectionStore } from './ipc/ssh'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from './ipc/ssh-session-teardown'
import { getRegisteredSshState } from './ssh/ssh-target-registry'
import type { EphemeralVmRecipeConnection } from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultConnection } from '../shared/ephemeral-vm-recipes'
import type { SshTarget } from '../shared/ssh-types'

const SSH_PROVIDER_READY_TIMEOUT_MS = 10_000
const SSH_PROVIDER_READY_INTERVAL_MS = 100

type RuntimeOwnedSshConnection = Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>

export type RuntimeOwnedSshConnectionResult = {
  targetId: string
  target: SshTarget
}

/**
 * `attached`: connected with the PTY provider registered. `reconnecting`: the relay is
 * recovering on its own and a fresh dial would tear that down. `detached`: nothing in
 * this process serves the target — the state after an app restart, or the moment
 * between a connect and the relay registering its providers.
 */
export type RuntimeOwnedSshRelayState = 'attached' | 'reconnecting' | 'detached'

export async function connectRuntimeOwnedSshTarget(args: {
  runtimeId: string
  connection: RuntimeOwnedSshConnection
  signal?: AbortSignal
}): Promise<RuntimeOwnedSshConnectionResult> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  const target = store.upsertRuntimeOwnedTarget(args.runtimeId, args.connection.target)
  try {
    await connectAndAwaitRuntimeSshProviders(target.id, args.signal)
  } catch (error) {
    // The target is persisted at upsert, so a failed connect/provider-wait would
    // orphan it; remove it (idempotent) before rethrowing so cleanup is complete.
    await removeRegisteredSshTarget(target.id).catch(() => undefined)
    throw error
  }
  return { targetId: target.id, target }
}

export function getRuntimeOwnedSshRelayState(targetId: string): RuntimeOwnedSshRelayState {
  const status = getRegisteredSshState(targetId)?.status
  if (status === 'connected' && getSshPtyProvider(targetId)) {
    return 'attached'
  }
  return status === 'reconnecting' ? 'reconnecting' : 'detached'
}

/**
 * Whether dialing this target would stop on a credential prompt. Read from the persisted
 * row the same way the renderer's startup restore partitions eager vs deferred targets:
 * without attempting a connection first. A prompt sent before the renderer has a
 * listener would only burn the credential timeout.
 */
export function runtimeOwnedSshTargetNeedsCredentialPrompt(targetId: string): boolean {
  return getSshConnectionStore()?.getTarget(targetId)?.lastRequiredPassphrase === true
}

/**
 * Re-establish the relay for a runtime that is still running. Unlike the provisioning
 * connect, a failure keeps the target row: the workspace still points at it and the
 * VM is up, so the next activation or terminal spawn retries instead of orphaning it.
 *
 * Resolves without dialing when the relay is `reconnecting`: it re-registers its
 * providers itself and a second dial would tear the recovering session down.
 */
export async function reattachRuntimeOwnedSshTarget(
  runtime: EphemeralVmRuntimeRecord & { sshTargetId: string },
  signal?: AbortSignal
): Promise<void> {
  const relayState = getRuntimeOwnedSshRelayState(runtime.sshTargetId)
  if (relayState === 'attached' || relayState === 'reconnecting') {
    return
  }
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  const connection = getEphemeralVmRecipeResultConnection(runtime.recipeResult)
  if (connection.type !== 'ssh') {
    throw new Error(`Runtime "${runtime.id}" has no SSH connection to re-attach.`)
  }
  // Why re-upsert: the target row lives in the profile, the runtime record in its own
  // file; recreating the row from the recipe result heals a profile that lost it.
  const target = store.upsertRuntimeOwnedTarget(runtime.id, connection.target)
  // Why always dial, even over a `connected` transport with no providers: the registered
  // connect already treats a live relay as a refresh, and a transport whose relay never
  // came up (relay-lost grace, half-attached after a crash) is exactly what a redial heals.
  // Waiting on it instead would burn the provider timeout and never recover.
  await connectAndAwaitRuntimeSshProviders(target.id, signal)
}

export async function disconnectRuntimeOwnedSshTarget(targetId: string | undefined): Promise<void> {
  if (!targetId) {
    return
  }
  await disconnectRegisteredSshTarget(targetId)
}

export async function removeRuntimeOwnedSshTarget(targetId: string | undefined): Promise<void> {
  if (!targetId) {
    return
  }
  await removeRegisteredSshTarget(targetId)
}

async function connectAndAwaitRuntimeSshProviders(
  targetId: string,
  signal?: AbortSignal
): Promise<void> {
  const state = await connectRegisteredSshTarget(targetId)
  if (state.status !== 'connected') {
    throw new Error(state.error || `SSH target did not connect: ${state.status}`)
  }
  await waitForRuntimeSshProviders(targetId, signal)
}

async function waitForRuntimeSshProviders(targetId: string, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SSH_PROVIDER_READY_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw new Error(`SSH provider wait aborted for target "${targetId}".`)
    }
    // Why the PTY provider too: a terminal spawn right after connect otherwise races
    // the relay's provider registration and fails with "No PTY provider".
    if (
      getSshGitProvider(targetId) &&
      getSshFilesystemProvider(targetId) &&
      getSshPtyProvider(targetId)
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, SSH_PROVIDER_READY_INTERVAL_MS))
  }
  throw new Error(`SSH relay providers were not ready for target "${targetId}".`)
}
