/** Managed orcad servers over SSH; desktop-only, so web clients leave it undefined. */
import { ipcRenderer } from 'electron'
import type {
  OrcadDeltaMovePreview,
  OrcadDeltaMoveResult,
  OrcadManagedCancelStopResult,
  OrcadManagedConversionResult,
  OrcadManagedDeployResult,
  OrcadManagedPendingMigrationRow,
  OrcadManagedRecoveryResult,
  OrcadManagedRollbackResult,
  OrcadManagedRuntimeStatus,
  OrcadManagedStopResult
} from '../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type {
  RuntimeSshAccessLinkRequest,
  RuntimeSshAccessUnlinkRequest
} from '../../shared/runtime-ssh-access'

export type ManagedOrcadPreloadApi = {
  deploy: (args: {
    name: string
    sshTargetId: string
    force?: boolean
  }) => Promise<OrcadManagedDeployResult>
  getStatus: (args: { selector: string }) => Promise<OrcadManagedRuntimeStatus>
  update: (args: { selector: string; force?: boolean }) => Promise<OrcadManagedDeployResult>
  rollback: (args: { selector: string }) => Promise<OrcadManagedRollbackResult>
  recover: (args: {
    selector: string
    /** Restore the snapshot over state a rejected build changed; see ORCAD_RECOVERY_CHANGED_STATE_CODE. */
    acceptChangedState?: boolean
  }) => Promise<OrcadManagedRecoveryResult>
  stop: (args: { selector: string }) => Promise<OrcadManagedStopResult>
  cancelStop: (args: { selector: string }) => Promise<OrcadManagedCancelStopResult>
  linkSshAccess: (args: RuntimeSshAccessLinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  unlinkSshAccess: (args: RuntimeSshAccessUnlinkRequest) => Promise<PublicKnownRuntimeEnvironment>
  convertSshHost: (args: {
    sshTargetId: string
    name: string
  }) => Promise<OrcadManagedConversionResult>
  listPendingMigrations: () => Promise<OrcadManagedPendingMigrationRow[]>
  previewDeltaMove: (args: { sshTargetId: string }) => Promise<OrcadDeltaMovePreview>
  moveDelta: (args: { sshTargetId: string }) => Promise<OrcadDeltaMoveResult>
  keepServerVersion: (args: { sshTargetId: string }) => Promise<void>
}

export const managedOrcadApi: ManagedOrcadPreloadApi = {
  deploy: (args) => ipcRenderer.invoke('runtimeEnvironments:deployOrcad', args),
  getStatus: (args) => ipcRenderer.invoke('runtimeEnvironments:getOrcadStatus', args),
  update: (args) => ipcRenderer.invoke('runtimeEnvironments:updateOrcad', args),
  rollback: (args) => ipcRenderer.invoke('runtimeEnvironments:rollbackOrcad', args),
  recover: (args) => ipcRenderer.invoke('runtimeEnvironments:recoverOrcad', args),
  stop: (args) => ipcRenderer.invoke('runtimeEnvironments:stopOrcad', args),
  cancelStop: (args) => ipcRenderer.invoke('runtimeEnvironments:cancelOrcadStop', args),
  linkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:linkSshAccess', args),
  unlinkSshAccess: (args) => ipcRenderer.invoke('runtimeEnvironments:unlinkSshAccess', args),
  convertSshHost: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:convertSshHostToManagedOrcad', args),
  listPendingMigrations: () => ipcRenderer.invoke('runtimeEnvironments:listPendingOrcadMigrations'),
  previewDeltaMove: (args) => ipcRenderer.invoke('runtimeEnvironments:previewOrcadDeltaMove', args),
  moveDelta: (args) => ipcRenderer.invoke('runtimeEnvironments:moveOrcadDelta', args),
  keepServerVersion: (args) =>
    ipcRenderer.invoke('runtimeEnvironments:keepOrcadServerVersion', args)
}
