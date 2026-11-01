import { ipcMain } from 'electron'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-pairing-verification'
import { verifyAndRepairRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { publishVerifiedPairing } from './runtime-environment-verified-pairing-publish'

export function registerRuntimeEnvironmentRepairHandler({
  getUserDataPath,
  invalidateTransport
}: {
  getUserDataPath: () => string
  invalidateTransport: (environmentId: string) => Promise<void> | void
}): void {
  ipcMain.handle(
    'runtimeEnvironments:repairFromPairingCode',
    async (
      _event,
      args: { selector: string; pairingCode: string }
    ): Promise<VerifyAndAddRuntimeEnvironmentResult> => {
      const result = await verifyAndRepairRuntimeEnvironmentFromPairingCode(getUserDataPath(), args)
      if (result.ok) {
        await publishVerifiedPairing(getUserDataPath(), result, { invalidateTransport })
      }
      return result
    }
  )
}
