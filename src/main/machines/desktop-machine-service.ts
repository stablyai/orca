import { BrowserWindow } from 'electron'
import { machineProviderKey, type MachineProviderSnapshot } from '../../shared/machine-inventory'
import { getSshConnectionStore } from '../ipc/ssh/ssh'
import {
  disconnectRegisteredSshTarget,
  removeRegisteredSshTarget
} from '../ipc/ssh/ssh-session-teardown'
import {
  verifyAndAddRuntimeEnvironmentFromPairingCode,
  verifyAndRepairRuntimeEnvironmentFromPairingCode
} from '../ipc/runtime-environments/runtime-environment-pairing-verification'
import type { PluginService } from '../plugins/plugin-service'
import { connectRegisteredSshTarget } from '../ssh/targets/ssh-target-registry'
import type { MachineSshTargets } from './machine-connect'
import { MachineService, type MachineProviderEntry } from './machine-service'

let registered: { service: MachineService; isEnabled: () => boolean } | null = null

/** The host's MachineService for runtime RPC; null where none is registered or the flag is off. */
export function getMachineService(): MachineService | null {
  return registered?.isEnabled() ? registered.service : null
}

function requireSshStore(): NonNullable<ReturnType<typeof getSshConnectionStore>> {
  const store = getSshConnectionStore()
  if (!store) {
    throw new Error('SSH handlers are not registered.')
  }
  return store
}

const sshTargets: MachineSshTargets = {
  getTarget: (id) => getSshConnectionStore()?.getTarget(id),
  ensureTarget: (id, fields) => requireSshStore().ensureMachineOwnedTarget(id, fields),
  updateTarget: (id, updates) => requireSshStore().updateTarget(id, updates),
  connect: (id) => connectRegisteredSshTarget(id),
  disconnect: (id) => disconnectRegisteredSshTarget(id)
}

function listPluginMachineProviders(pluginService?: PluginService): MachineProviderEntry[] {
  return (pluginService?.contentPacks.vmRecipes.listMachineProviders() ?? []).map(
    ({ pluginKey, pluginRootDir, provider }) => ({
      providerKey: machineProviderKey(pluginKey, provider.id),
      name: provider.name,
      source: { command: provider.command, pluginRootDir }
    })
  )
}

function broadcastMachinesChanged(snapshot: MachineProviderSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send('machines:changed', snapshot)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

/** Providers run in this process, with this desktop's ssh config and credentials. */
export function createDesktopMachineService(
  userDataPath: string,
  pluginService: PluginService | undefined,
  isEnabled: () => boolean
): MachineService {
  const service = new MachineService({
    userDataPath,
    listProviders: () => listPluginMachineProviders(pluginService),
    onChanged: broadcastMachinesChanged,
    sshTargets,
    removeSshTarget: removeRegisteredSshTarget,
    pairing: {
      add: ({ name, pairingCode }) =>
        verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, {
          name,
          pairingCode,
          allowLoopback: false
        }),
      repair: (args) => verifyAndRepairRuntimeEnvironmentFromPairingCode(userDataPath, args)
    }
  })
  registered = { service, isEnabled }
  return service
}
