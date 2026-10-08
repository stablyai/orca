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
import { censusHostRelayTerminalsFor } from '../ssh/ssh-host-relay-census-for-target'
import { orcadMigrationDestinationFor } from '../ssh/orcad-runtime-conversion-wiring'
import { hasRegisteredDirectSshAuthority } from '../ssh/ssh-target-registry'
import { requiredString } from './orcad-runtime-lifecycle-handlers'
import { disconnectRegisteredSshTarget } from './ssh-session-teardown'
import { publishResolvedChangedHostStatus } from './runtime-environment-managed-tunnel'
import { runTargetLifecycle } from './ssh-target-lifecycle-queue'

export function registerOrcadDeltaMoveHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:previewOrcadDeltaMove',
    (_event, args: { sshTargetId: string }): OrcadDeltaMovePreview => {
      const { store, target } = requireChangedHost(args)
      const plan = planOrcadDeltaMove(getUserDataPath(), store, target)
      const { sshTargetId, environmentId, added, notReflected, blockers } = plan
      return { sshTargetId, environmentId, added, notReflected, blockers }
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:moveOrcadDelta',
    async (_event, args: { sshTargetId: string }): Promise<OrcadDeltaMoveResult> => {
      const userDataPath = getUserDataPath()
      const { store, claims, target } = requireChangedHost(args)
      const environment = listEnvironments(userDataPath).find(
        (entry) => entry.id === target.orcadFence?.environmentId
      )
      if (!environment) {
        throw new Error('The managed Orca server for this host is no longer registered.')
      }
      const result = await runOrcadDeltaMove({
        userDataPath,
        store,
        claims,
        target,
        environment,
        destination: orcadMigrationDestinationFor(environment),
        listRelayPtyIds: orcadMigrationRelayPtyLister(target.id),
        censusHost: censusHostRelayTerminalsFor(target),
        releaseDirectSession: async (targetId) => {
          if (hasRegisteredDirectSshAuthority(targetId)) {
            await disconnectRegisteredSshTarget(targetId)
          }
        },
        ensureTunnel: async () => {
          await ensureOrcadManagedTunnel(userDataPath, environment.id)
        },
        runTargetLifecycle
      })
      if (result.outcome === 'moved') {
        publishResolvedChangedHostStatus(target, environment.id)
      }
      return result
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:keepOrcadServerVersion',
    async (_event, args: { sshTargetId: string }): Promise<void> => {
      const { store, claims, target, environmentId } = requireChangedHost(args)
      await runTargetLifecycle(target.id, () =>
        keepOrcadServerVersion({ userDataPath: getUserDataPath(), store, claims, target })
      )
      publishResolvedChangedHostStatus(target, environmentId)
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
  return { store, claims, target, environmentId: target.orcadFence.environmentId }
}
