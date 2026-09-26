import { hostname } from 'node:os'
import { app, ipcMain } from 'electron'
import { LOCAL_RENDERER_PRESENTATION_CLIENT_KEY } from '../../shared/cross-machine-recovery-presentation-types'
import { CrossMachineRecoveryPresentationPublishParams } from '../../shared/rpc-contract/cross-machine-recovery-params'
import { readOrMintCrossMachineRecoveryClientInstanceId } from '../runtime/cross-machine-recovery/client-instance-id'
import { CrossMachineRecoveryPresentationStore } from '../runtime/cross-machine-recovery/presentation-store'

export function registerCrossMachineRecoveryPresentationHandlers(): void {
  let store: CrossMachineRecoveryPresentationStore | null = null
  ipcMain.handle('crossMachineRecovery:publishPresentationLocal', (_event, params: unknown) => {
    store ??= new CrossMachineRecoveryPresentationStore(app.getPath('userData'))
    return store.record(
      LOCAL_RENDERER_PRESENTATION_CLIENT_KEY,
      'local-renderer',
      CrossMachineRecoveryPresentationPublishParams.parse(params),
      Date.now()
    )
  })
  ipcMain.handle('crossMachineRecovery:getClientInstanceId', () =>
    readOrMintCrossMachineRecoveryClientInstanceId(app.getPath('userData'))
  )
  ipcMain.handle('crossMachineRecovery:getClientName', () => hostname())
}
