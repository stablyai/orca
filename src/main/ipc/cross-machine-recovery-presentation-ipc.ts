import { hostname } from 'node:os'
import { ipcMain } from 'electron'
import { LOCAL_RENDERER_PRESENTATION_CLIENT_KEY } from '../../shared/cross-machine-recovery-presentation-types'
import { CrossMachineRecoveryPresentationPublishParams } from '../../shared/rpc-contract/cross-machine-recovery-params'
import { readOrMintCrossMachineRecoveryClientInstanceId } from '../runtime/cross-machine-recovery/client-instance-id'
import { getCrossMachineRecoveryPresentationStore } from '../runtime/cross-machine-recovery/presentation-store-instance'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'

export function registerCrossMachineRecoveryPresentationHandlers(): void {
  ipcMain.handle('crossMachineRecovery:publishPresentationLocal', (_event, params: unknown) =>
    getCrossMachineRecoveryPresentationStore().record(
      LOCAL_RENDERER_PRESENTATION_CLIENT_KEY,
      'local-renderer',
      CrossMachineRecoveryPresentationPublishParams.parse(params),
      Date.now()
    )
  )
  ipcMain.handle('crossMachineRecovery:getClientInstanceId', () =>
    readOrMintCrossMachineRecoveryClientInstanceId(getProfileUserDataPath())
  )
  ipcMain.handle('crossMachineRecovery:getClientName', () => hostname())
}
