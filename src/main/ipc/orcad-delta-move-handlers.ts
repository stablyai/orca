/** IPC for a host an older build changed after conversion: move its newer projects, or keep the server's. */
import { ipcMain } from 'electron'
import type {
  OrcadDeltaMovePreview,
  OrcadDeltaMoveResult
} from '../../shared/orcad-managed-runtime'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { requireManagedOrcadInfrastructure } from '../ssh/orcad-managed-runtime-context'
import { ensureOrcadManagedTunnel } from '../ssh/orcad-managed-tunnel'
import { keepOrcadServerVersion, runOrcadDeltaMove } from '../ssh/orcad-migration-delta-move'
import { planOrcadDeltaMove } from '../ssh/orcad-migration-delta-plan'
import { orcadMigrationRelayPtyLister } from '../ssh/orcad-migration-relay-pty-lister'
import { orcadMigrationDestinationFor } from '../ssh/orcad-runtime-conversion-wiring'
import { hasRegisteredDirectSshAuthority } from '../ssh/ssh-target-registry'
import { requiredString } from './orcad-runtime-lifecycle-handlers'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export function registerOrcadDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewOrcadDeltaMove',
    (_event, args: { sshTargetId: string }): OrcadDeltaMovePreview => {
      const { store, target } = requireChangedHost(args)
      const {
        manifest: _manifest,
        moved: _moved,
        ...preview
      } = planOrcadDeltaMove(getUserDataPath(), store, target)
      return preview
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveOrcadDelta',
    (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.orcadFence?.environmentId
      )
      if (!environment) {
        throw new Error('The managed Orca server for this host is no longer registered.')
      }
      return runOrcadDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        destination: orcadMigrationDestinationFor(environment),
        listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
        releaseDirectSession: async (targetId) => {
          if (hasRegisteredDirectSshAuthority(targetId)) {
            await disconnectRegisteredSshTarget(targetId)
          }
        },
        ensureTunnel: async () => {
          await ensureOrcadManagedTunnel(userDataPath, environment.id)
        }
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepOrcadServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepOrcadServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
    }
  )
}

function requireChangedHost(args: { sshTargetId: string } | undefined) {
  const sshTargetId = requiredString(args?.sshTargetId, 'SSH target')
  const { targetStore, claims } = requireManagedOrcadInfrastructure()
  const store = targetStore.getOrcadMigrationSource()
  const target = store.getSshTarget(sshTargetId)
  if (!target?.orcadFence?.sourceChangedAt) {
    throw new Error('This SSH host has no changes from an older Orca to resolve.')
  }
  return { store, claims, target }
}
