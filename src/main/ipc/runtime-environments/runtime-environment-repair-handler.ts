import { ipcMain } from 'electron'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-pairing-verification'
import { verifyAndRepairRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'

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
      if (!result.ok) {
        return result
      }
      const environmentId = result.environment.id
      // Why before invalidating: a manually disconnected server would not get a fresh owner.
      clearRuntimeEnvironmentManualDisconnect(environmentId)
      // Retires the owner blocked under the revoked pairing; its replacement keys on the new revision.
      await invalidateTransport(environmentId)
      getRuntimeEnvironmentStatusOwner(getUserDataPath(), environmentId).acceptVerified({
        id: 'status.get',
        ok: true,
        result: result.runtimeStatus,
        _meta: { runtimeId: result.runtimeStatus.runtimeId }
      })
      return result
    }
  )
}
