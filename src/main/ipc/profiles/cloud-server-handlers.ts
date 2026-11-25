import { app, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaAccountService } from '../../orca-profiles/orca-account-service'
import { DEFAULT_CLOUD_SERVER } from '../../../shared/settings/custom-cloud-server'
import {
  switchCloudServer,
  testCloudServerConnection
} from '../../orca-profiles/cloud-auth/profile-cloud-server-settings'
import { mainProcessState as state } from '../../startup/main-process-state'
import { replaceMainProcessRelayService } from '../../startup/cloud-startup/main-process-relay-startup'
import { broadcastOrcaProfileAuthStatusChanged } from './orca-profile-auth-status-broadcast'

export function registerCloudServerHandlers(store: Store, account: OrcaAccountService): void {
  ipcMain.handle('orcaProfiles:cloudServerSettings', () => ({
    settings: store.getSettings().customCloudServer ?? DEFAULT_CLOUD_SERVER,
    allowLoopbackHttp: !app.isPackaged,
    environmentOverrides: Object.keys(process.env).some(
      (key) =>
        (key.startsWith('ORCA_CLOUD_') || key === 'ORCA_RELAY_URL') &&
        Boolean(process.env[key]?.trim())
    )
  }))
  ipcMain.handle('orcaProfiles:testCloudServer', (_event, value: unknown) =>
    testCloudServerConnection(value, app.isPackaged)
  )
  ipcMain.handle('orcaProfiles:switchCloudServer', async (_event, value: unknown) => {
    const runtimeRpc = state.core.runtimeRpc
    if (!runtimeRpc) {
      throw new Error('runtime_unavailable')
    }
    try {
      return await switchCloudServer(value, {
        store,
        account,
        runtimeRpc,
        packaged: app.isPackaged,
        stopRelay: () => {
          state.core.relayHost?.signOutStarted()
          state.core.relayHost?.stop()
        },
        restartRelay: () => replaceMainProcessRelayService(runtimeRpc)
      })
    } finally {
      broadcastOrcaProfileAuthStatusChanged()
    }
  })
}
