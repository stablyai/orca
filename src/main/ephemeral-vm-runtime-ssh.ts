import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import {
  connectRegisteredSshTarget,
  disconnectRegisteredSshTarget,
  getSshConnectionStore,
  removeRegisteredSshTarget
} from './ipc/ssh'
import type { EphemeralVmRecipeConnection } from '../shared/ephemeral-vm-recipes'
import type { SshTarget } from '../shared/ssh-types'

const SSH_PROVIDER_READY_TIMEOUT_MS = 10_000
const SSH_PROVIDER_READY_INTERVAL_MS = 100

export type RuntimeOwnedSshConnectionResult = {
  targetId: string
  target: SshTarget
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
  const state = await connectRegisteredSshTarget(target.id)
  if (state.status !== 'connected') {
    throw new Error(state.error || `SSH target did not connect: ${state.status}`)
  }
  await waitForRuntimeSshProviders(target.id)
  return { targetId: target.id, target }
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

async function waitForRuntimeSshProviders(targetId: string): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < SSH_PROVIDER_READY_TIMEOUT_MS) {
    if (getSshGitProvider(targetId) && getSshFilesystemProvider(targetId)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, SSH_PROVIDER_READY_INTERVAL_MS))
  }
  throw new Error(`SSH relay providers were not ready for target "${targetId}".`)
}
