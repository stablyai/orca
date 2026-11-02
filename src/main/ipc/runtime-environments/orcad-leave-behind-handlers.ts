/** IPC for "Move anyway": the user confirms that saved state a move can't carry stays on this desktop. */
import { ipcMain } from 'electron'
import { getSshTargetRegistryStore } from '../../ssh/ssh-target-registry'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadLeaveBehindHandlers(): void {
  ipcMain.handle(
    'runtimeEnvironments:allowOrcadMoveLeavingBehind',
    (_event, args: { sshTargetId: string }): void => {
      const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
      const registry = getSshTargetRegistryStore()
      if (!registry?.getTarget(sshTargetId)) {
        throw new Error('The SSH host is gone.')
      }
      // Read by the export on the next connect; cleared once the host moves.
      registry.updateTarget(sshTargetId, {
        managedServerLeaveBehind: { confirmedAt: new Date().toISOString() }
      })
    }
  )
}
