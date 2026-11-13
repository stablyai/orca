// EP-8: wires the pairing recovery (cloud-pairing-recovery.ts) to this process: which environments
// are cloud workspaces, the grant call, the same-server repair and the window notice.
import { app, BrowserWindow } from 'electron'
import { resolveEnvironment } from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { cloudSandboxIdForEnvironment } from '../hosted-sandbox/cloud-delete-preflight'
import { verifyAndRepairRuntimeEnvironmentFromPairingCode } from '../ipc/runtime-environments/runtime-environment-pairing-verification'
import { invalidateRuntimeEnvironmentTransport } from '../ipc/runtime-environments/runtime-environments'
import { setRuntimeEnvironmentRejectionObserver } from '../ipc/runtime-environments/runtime-environment-rejection-observer'
import {
  readActiveAccountBindings,
  rebindCloudPairingGrant
} from '../ipc/cloud-workspaces-pairings'
import type { CloudWorkspacesService } from './cloud-workspaces-service'
import { createCloudPairingRecovery } from './cloud-pairing-recovery'

export const CLOUD_ACCESS_LOST_CHANNEL = 'cloudWorkspaces:accessLost'

export function installCloudPairingRecovery(
  getService: () => Promise<CloudWorkspacesService | null>
): void {
  const userDataPath = (): string => app.getPath('userData')
  const recovery = createCloudPairingRecovery({
    target: async (environmentId) => {
      const sandboxId = cloudSandboxIdForEnvironment(userDataPath(), environmentId)
      if (!sandboxId) {
        return null
      }
      const binding = Object.entries(await readActiveAccountBindings()).find(
        ([, b]) => b.environmentId === environmentId
      )
      return binding
        ? { sandboxId, kind: 'paired', grantId: binding[1].grantId }
        : { sandboxId, kind: 'owned', grantId: null }
    },
    revision: (environmentId) => {
      try {
        const environment = resolveEnvironment(userDataPath(), environmentId)
        return environment.pairingRevision ?? environment.createdAt
      } catch {
        return null
      }
    },
    openGrant: async (sandboxId) => {
      const s = await getService().catch(() => null)
      return s ? s.openGrant(sandboxId) : { ok: false, error: 'not_configured' }
    },
    repair: async (environmentId, pairingCode) =>
      (
        await verifyAndRepairRuntimeEnvironmentFromPairingCode(
          userDataPath(),
          { selector: environmentId, pairingCode },
          { allowCloudWorkspace: true }
        )
      ).ok,
    bind: (sandboxId, _environmentId, grantId) => rebindCloudPairingGrant(sandboxId, grantId),
    revokeGrant: async (sandboxId, grantId) => {
      await (await getService().catch(() => null))?.revokeGrant(sandboxId, grantId)
    },
    invalidate: (environmentId) => invalidateRuntimeEnvironmentTransport(environmentId),
    onAccessLost: (environmentId, sandboxId) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(CLOUD_ACCESS_LOST_CHANNEL, { environmentId, sandboxId })
        }
      }
    }
  })
  setRuntimeEnvironmentRejectionObserver((environmentId, error) =>
    recovery.noteRejected(environmentId, error.code, error.message)
  )
}
