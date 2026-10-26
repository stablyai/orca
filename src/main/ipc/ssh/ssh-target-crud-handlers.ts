import { ipcMain } from 'electron'
import type {
  SshConfigHostListArgs,
  SshRepoReadoption,
  SshTarget,
  SshTargetAddResult,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../../shared/ssh-types'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../../ssh/config/ssh-config-host-picker'
import { getManagedOrcadFenceEnvironmentId } from '../../../shared/managed-orcad-ssh-owner'
import { closeOrcadManagedTunnel } from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { rotateSshProviderAuthority } from '../../ssh/ssh-provider-authority'
import {
  getSshTargetRegistryStore,
  setSshTargetMutations
} from '../../ssh/targets/ssh-target-registry'
import {
  allowsDirectSshRelay,
  isManagedOrcadSshTarget,
  isRuntimeOwnedSshTarget
} from '../../ssh/connection/ssh-connection-store'
import { connectionManager, getCurrentMainWindow } from './ssh-ipc-context'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'
import { fingerprintRuntimeSshTarget } from '../../ssh/runtime-ssh-target-fingerprint'
import { removeRegisteredSshTarget } from './ssh-session-teardown'
import { notifyReposChanged } from '../repos/repos-changed-notification'
import { requestDesktopBrowserBridgeReconcile } from '../desktop-browser-bridge-reconcile'

// Add/import can re-adopt orphaned workspaces; report them so the renderer refreshes repo ownership.
function takeRepoReadoptions(): SshRepoReadoption[] {
  const store = getSshTargetRegistryStore()
  if (!store || store.lastRepoReadoptions.length === 0) {
    return []
  }
  const repoReadoptions = store.lastRepoReadoptions
  store.lastRepoReadoptions = []
  for (const targetId of new Set(
    repoReadoptions.flatMap(({ oldTargetId, newTargetId }) => [oldTargetId, newTargetId])
  )) {
    rotateSshProviderAuthority(targetId)
  }
  // Paired clients refetch repositories only on this event.
  notifyReposChanged(getCurrentMainWindow())
  return repoReadoptions
}

// Generation, provisioning, fences and runtime ladder cache are main-owned; strip renderer claims.
function omitRendererSshTargetGeneration<
  T extends {
    generation?: unknown
    orcadProvisioning?: unknown
    orcadFence?: unknown
    managedServerUnavailable?: unknown
    managedServerMoveOffered?: unknown
    managedServerLeaveBehind?: unknown
    managedServerUpdateFailure?: unknown
    remoteRuntimeResolution?: unknown
  }
>(
  value: T
): Omit<
  T,
  | 'generation'
  | 'orcadProvisioning'
  | 'orcadFence'
  | 'managedServerUnavailable'
  | 'managedServerMoveOffered'
  | 'managedServerLeaveBehind'
  | 'managedServerUpdateFailure'
  | 'remoteRuntimeResolution'
> {
  const {
    generation: _generation,
    orcadProvisioning: _orcadProvisioning,
    orcadFence: _orcadFence,
    managedServerUnavailable: _managedServerUnavailable,
    managedServerMoveOffered: _managedServerMoveOffered,
    managedServerLeaveBehind: _managedServerLeaveBehind,
    managedServerUpdateFailure: _managedServerUpdateFailure,
    remoteRuntimeResolution: _remoteRuntimeResolution,
    ...rest
  } = value
  return rest
}

function assertNotRuntimeOwned(targetId: string, action: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isRuntimeOwnedSshTarget(target)) {
    throw new Error(`Managed runtime SSH targets cannot be ${action} from SSH settings.`)
  }
}

/** Removing a managed host would strand its server; Stop proves the exit, Forget skips a dead host. */
export function assertNotManagedServerHost(targetId: string): void {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (target && isManagedOrcadSshTarget(target)) {
    throw new Error(
      'Orca runs on this host. Use Stop… under Settings › Orca on your SSH hosts to stop it and remove it from the host first, or Forget… there if the host is gone.'
    )
  }
}

function addSshTarget(input: SshTargetCreateInput): SshTargetAddResult {
  const target = getSshTargetRegistryStore()!.addTarget(omitRendererSshTargetGeneration(input))
  const repoReadoptions = takeRepoReadoptions()
  return { target, repoReadoptions }
}

function updateSshTarget(id: string, updates: SshTargetUpdateInput): SshTarget | null {
  assertNotRuntimeOwned(id, 'edited')
  const before = getSshTargetRegistryStore()!.getTarget(id)
  // The fence and generation are stripped, so a managed host keeps its server binding.
  const updated = getSshTargetRegistryStore()!.updateTarget(
    id,
    omitRendererSshTargetGeneration(updates)
  )
  // Revoke desktop-browser control immediately when permission is disabled.
  requestDesktopBrowserBridgeReconcile()
  const environmentId = getManagedOrcadFenceEnvironmentId(updated ?? undefined)
  if (environmentId && updated) {
    // Edited managed hosts need fresh tunnels and transports; unserved hosts have no managed route to redial.
    const redial =
      !allowsDirectSshRelay(updated) &&
      (!before || fingerprintRuntimeSshTarget(before) !== fingerprintRuntimeSshTarget(updated))
    void runTargetLifecycle(id, async () => {
      await closeOrcadManagedTunnel(environmentId)
      if (redial) {
        await connectionManager?.disconnect(id)
      }
    }).catch(() => undefined)
  }
  return updated
}

async function removeSshTarget(id: string): Promise<void> {
  assertNotRuntimeOwned(id, 'removed')
  assertNotManagedServerHost(id)
  await removeRegisteredSshTarget(id)
  requestDesktopBrowserBridgeReconcile()
}

export function registerSshTargetCrudHandlers(): void {
  // Apply identical mutation rules to paired RPC and local Settings.
  setSshTargetMutations({ add: addSshTarget, update: updateSshTarget, remove: removeSshTarget })

  ipcMain.handle('ssh:listTargets', () => {
    return getSshTargetRegistryStore()!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return getSshTargetRegistryStore()!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: SshTargetCreateInput }) =>
    addSshTarget(args.target)
  )

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: SshTargetUpdateInput }) =>
      updateSshTarget(args.id, args.updates)
  )

  ipcMain.handle('ssh:removeTarget', (_event, args: { id: string }) => removeSshTarget(args.id))

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) => {
    const targets = getSshTargetRegistryStore()!.importFromSshConfig(args)
    const repoReadoptions = takeRepoReadoptions()
    return { targets, repoReadoptions }
  })

  // Prefill the add-host form without importing targets; bulk sync belongs to Settings.
  ipcMain.handle('ssh:listConfigHosts', (_event, args?: SshConfigHostListArgs) => {
    return listUserSshConfigHostSummaries(
      getSshTargetRegistryStore()!.listTargets(),
      args?.query,
      getSshTargetRegistryStore()!.listSuppressedSshConfigAliases(),
      { refresh: args?.refresh === true }
    )
  })

  ipcMain.handle('ssh:resolveConfigHost', (_event, args: { alias: string }) => {
    return resolveUserSshConfigHost(args.alias)
  })
}
