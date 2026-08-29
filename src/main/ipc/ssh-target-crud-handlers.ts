import { ipcMain } from 'electron'
import type {
  SshConfigHostListArgs,
  SshRepoReadoption,
  SshTargetCreateInput,
  SshTargetUpdateInput
} from '../../shared/ssh-types'
import {
  listUserSshConfigHostSummaries,
  resolveUserSshConfigHost
} from '../ssh/ssh-config-host-picker'
import { rotateSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getSshTargetRegistryStore } from '../ssh/ssh-target-registry'
import { getCurrentMainWindow } from './ssh-ipc-context'
import { removeRegisteredSshTarget } from './ssh-session-teardown'

// Why: add/import can re-adopt workspaces orphaned on a removed target id (see ssh-target-readoption); the renderer must refresh its repo list to surface them.
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
  const win = getCurrentMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('repos:changed')
  }
  return repoReadoptions
}

function omitRendererSshTargetGeneration<T extends object>(value: T): Omit<T, 'generation'> {
  const { generation: _generation, ...rest } = value as T & { generation?: unknown }
  return rest
}

export function registerSshTargetCrudHandlers(): void {
  ipcMain.handle('ssh:listTargets', () => {
    return getSshTargetRegistryStore()!.listTargets()
  })

  ipcMain.handle('ssh:listRemovedTargetLabels', () => {
    return getSshTargetRegistryStore()!.listRemovedTargetLabels()
  })

  ipcMain.handle('ssh:addTarget', (_event, args: { target: SshTargetCreateInput }) => {
    const target = getSshTargetRegistryStore()!.addTarget(
      omitRendererSshTargetGeneration(args.target)
    )
    // Why: re-adding a removed host can re-adopt orphaned workspaces; refresh the renderer's repo list so they move back onto the live host.
    const repoReadoptions = takeRepoReadoptions()
    return { target, repoReadoptions }
  })

  ipcMain.handle(
    'ssh:updateTarget',
    (_event, args: { id: string; updates: SshTargetUpdateInput }) => {
      return getSshTargetRegistryStore()!.updateTarget(
        args.id,
        omitRendererSshTargetGeneration(args.updates)
      )
    }
  )

  ipcMain.handle('ssh:removeTarget', async (_event, args: { id: string }) => {
    await removeRegisteredSshTarget(args.id)
  })

  ipcMain.handle('ssh:importConfig', (_event, args?: { reAdopt?: boolean }) => {
    const targets = getSshTargetRegistryStore()!.importFromSshConfig(args)
    const repoReadoptions = takeRepoReadoptions()
    return { targets, repoReadoptions }
  })

  // Why: add-host dialog picks one config entry to prefill the form; does not
  // mutate the target store (bulk sync stays on Settings → Import).
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
