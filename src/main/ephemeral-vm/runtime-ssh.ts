import { getSshConnectionStore } from '../ipc/ssh/ssh'
import { connectRegisteredSshTarget } from '../ssh/targets/ssh-target-registry'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from '../ipc/ssh/ssh-session-teardown'
import type { EphemeralVmRecipeConnection } from '../../shared/ephemeral-vm-recipes'
import type { SshTarget } from '../../shared/ssh-types'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'

export type RuntimeOwnedSshConnectionResult = {
  targetId: string
  target: SshTarget
  environmentId: string
}

export async function connectRuntimeOwnedSshTarget(args: {
  runtimeId: string
  connection: Extract<EphemeralVmRecipeConnection, { type: 'ssh' }>
}): Promise<RuntimeOwnedSshConnectionResult> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  const target = store.upsertRuntimeOwnedTarget(args.runtimeId, args.connection.target)
  let environmentId: string
  try {
    const state = await connectRegisteredSshTarget(target.id)
    if (state.status !== 'connected') {
      throw new Error(state.error || `SSH target did not connect: ${state.status}`)
    }
    if (state.managedServer?.kind !== 'managed') {
      throw new SshHostNotServedError(target.id)
    }
    environmentId = state.managedServer.environmentId
  } catch (error) {
    // Upsert persisted the target; remove it on failure to avoid orphaning it.
    await removeRuntimeOwnedSshTarget(target.id).catch(() => undefined)
    throw error
  }
  return { targetId: target.id, target, environmentId }
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
