import { homedir } from 'node:os'
import { app, ipcMain, shell } from 'electron'
import { spawnDetachedWithoutInheritance } from '@orca/process-host/isolated-detached-spawn'
import {
  ORCA_UNINSTALL_STEPS,
  type OrcaUninstallFinishAction,
  type OrcaUninstallPlan,
  type OrcaUninstallRunStepArgs
} from '../../shared/uninstall/orca-uninstall-types'
import { getClaudeAgentViewService } from '../claude/agent-view/agent-view-service'
import type { Store } from '../persistence/loading-store/store'
import { getLinuxRootPackageType } from '../updater/linux-package/linux-update-package-type'
import {
  findWindowsUninstaller,
  resolveOrcaInstallIdentity
} from '../uninstall/orca-install-identity'
import {
  buildOrcaUninstallPlan,
  runOrcaUninstallStep,
  type OrcaUninstallHost
} from '../uninstall/orca-uninstall-cleanup'
import {
  listOrcaUninstallSshHosts,
  removeOrcaUninstallSshHostHooks
} from '../uninstall/orca-uninstall-ssh-hosts'
import { readLocalCliInstallStatus, removeLocalCliRegistration } from './cli'

async function createHost(store: Store): Promise<OrcaUninstallHost> {
  const userDataPath = app.getPath('userData')
  return {
    platform: process.platform,
    homeDir: homedir(),
    uid: process.getuid?.() ?? 0,
    identity: await resolveOrcaInstallIdentity({
      platform: process.platform,
      isPackaged: app.isPackaged,
      exePath: app.getPath('exe'),
      homeDir: homedir(),
      env: process.env,
      linuxPackageType: process.platform === 'linux' ? getLinuxRootPackageType() : null
    }),
    disableAgentStatusHooks: async () => {
      await store.updateSettingsAndFlush(
        { agentStatusHooksEnabled: false },
        { notifyListeners: true }
      )
      // Settle the agent-view disable so it can't rewrite the marker after cleanup deletes it.
      await getClaudeAgentViewService().reconcile(store.getSettings())
    },
    getCliStatus: readLocalCliInstallStatus,
    removeCli: removeLocalCliRegistration,
    listHosts: () => listOrcaUninstallSshHosts(userDataPath),
    removeHostHooks: (hostId) => removeOrcaUninstallSshHostHooks(userDataPath, hostId)
  }
}

async function openWindowsUninstaller(appPath: string | null): Promise<void> {
  const uninstaller =
    process.platform === 'win32' && appPath ? await findWindowsUninstaller(appPath) : null
  if (!appPath || !uninstaller) {
    throw new Error('The Orca uninstaller was not found.')
  }
  spawnDetachedWithoutInheritance({ program: uninstaller, args: [], cwd: appPath }).unref()
}

export function registerOrcaUninstallHandlers(store: Store): void {
  // Steps update the plan the renderer last read, so retries keep earlier results.
  let current: OrcaUninstallPlan | null = null

  ipcMain.handle('orcaUninstall:getPlan', async (): Promise<OrcaUninstallPlan> => {
    current = await buildOrcaUninstallPlan(await createHost(store))
    return current
  })

  ipcMain.handle(
    'orcaUninstall:runStep',
    async (_event, args: OrcaUninstallRunStepArgs): Promise<OrcaUninstallPlan> => {
      if (!ORCA_UNINSTALL_STEPS.includes(args?.step)) {
        throw new Error(`Unknown uninstall step: ${String(args?.step)}`)
      }
      const only = Array.isArray(args.only)
        ? args.only.filter((id): id is string => typeof id === 'string')
        : undefined
      const host = await createHost(store)
      current = await runOrcaUninstallStep(
        current ?? (await buildOrcaUninstallPlan(host)),
        args.step,
        host,
        only
      )
      return current
    }
  )

  ipcMain.handle(
    'orcaUninstall:finish',
    async (_event, action: OrcaUninstallFinishAction): Promise<void> => {
      const appPath = current?.appPath ?? (await createHost(store)).identity.appPath
      if (action === 'reveal-app') {
        if (appPath) {
          shell.showItemInFolder(appPath)
        }
        return
      }
      if (action === 'open-windows-uninstaller') {
        await openWindowsUninstaller(appPath)
        app.quit()
        return
      }
      if (action === 'quit') {
        app.quit()
      }
    }
  )
}
