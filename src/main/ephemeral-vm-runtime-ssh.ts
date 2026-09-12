import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { getSshPtyProvider } from './ipc/pty/provider/registry'
import { connectRegisteredSshTarget, getSshConnectionStore } from './ipc/ssh'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from './ipc/ssh-session-teardown'
import { getRuntimeOwnedSshTargetId } from './ssh/ssh-connection-store'
import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeConnection
} from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { SshTarget } from '../shared/ssh-types'

const SSH_PROVIDER_READY_TIMEOUT_MS = 10_000
const SSH_PROVIDER_READY_INTERVAL_MS = 100

export type RuntimeOwnedSshConnectionResult = {
  targetId: string
  target: SshTarget
}

type RuntimeOwnedSshConnectArgs = {
  runtimeId: string
  connection: Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>
  signal?: AbortSignal
}

export async function connectRuntimeOwnedSshTarget(
  args: RuntimeOwnedSshConnectArgs
): Promise<RuntimeOwnedSshConnectionResult> {
  try {
    return await openRuntimeOwnedSshTransport(args)
  } catch (error) {
    // The target is persisted at upsert, so a failed connect/provider-wait would
    // orphan it; remove it (idempotent) before rethrowing so cleanup is complete.
    await removeRuntimeOwnedSshTarget(getRuntimeOwnedSshTargetId(args.runtimeId)).catch(
      () => undefined
    )
    throw error
  }
}

/**
 * Restore the transport an SSH-backed runtime needs in *this* process, without touching the
 * runtime's lifecycle. Provider registration is process-local while the runtime record and its
 * SSH target row are durable, so a persisted runtime routinely outlives the connection that
 * served it (app restart, host restart, a resume the recipe skipped). Idempotent: a target that
 * still has a PTY provider is left alone, because redialing it would dispose the live relay
 * session the runtime layer owns.
 *
 * Returns the runtime-owned target id, or null when the runtime is not SSH-backed.
 *
 * Deliberately not routed through `connectRuntimeOwnedSshTarget`: that path removes the target on
 * failure, which disposes remote PTYs and drops their leases. For a runtime that is still alive
 * that would destroy the route on evidence we do not hold — a failed reconnect is `unverifiable`
 * (docs/reference/ssh-execution-boundary.md).
 */
export async function ensureRuntimeOwnedSshConnection(args: {
  runtime: EphemeralVmRuntimeRecord
  signal?: AbortSignal
}): Promise<string | null> {
  const connection = getEphemeralVmRecipeResultConnection(args.runtime.recipeResult)
  if (connection.type !== 'ssh') {
    return null
  }
  const targetId = getRuntimeOwnedSshTargetId(args.runtime.id)
  if (getSshPtyProvider(targetId)) {
    return targetId
  }
  const result = await openRuntimeOwnedSshTransport({
    runtimeId: args.runtime.id,
    connection,
    ...(args.signal ? { signal: args.signal } : {})
  })
  return result.targetId
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

async function openRuntimeOwnedSshTransport(
  args: RuntimeOwnedSshConnectArgs
): Promise<RuntimeOwnedSshConnectionResult> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  const target = store.upsertRuntimeOwnedTarget(args.runtimeId, args.connection.target)
  const state = await connectRegisteredSshTarget(target.id)
  if (state.status !== 'connected') {
    throw new Error(state.error || `SSH target did not connect: ${state.status}`)
  }
  await waitForRuntimeSshProviders(target.id, args.signal)
  return { targetId: target.id, target }
}

async function waitForRuntimeSshProviders(targetId: string, signal?: AbortSignal): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SSH_PROVIDER_READY_TIMEOUT_MS) {
    if (signal?.aborted) {
      throw new Error(`SSH provider wait aborted for target "${targetId}".`)
    }
    // The PTY provider is what terminal and agent work routes through; readiness that omits it
    // can report a target usable while `pty:spawn` still rejects with "No PTY provider".
    if (
      getSshPtyProvider(targetId) &&
      getSshGitProvider(targetId) &&
      getSshFilesystemProvider(targetId)
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, SSH_PROVIDER_READY_INTERVAL_MS))
  }
  throw new Error(`SSH relay providers were not ready for target "${targetId}".`)
}
