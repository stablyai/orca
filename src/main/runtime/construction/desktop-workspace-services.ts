import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeConstructionDependencies } from './runtime-construction-dependencies'
import { findWorkspaceEphemeralVmRuntime } from '../../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-workspace-runtime'
import { resolveEnvironment } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRuntimeEnvironmentRegistryRoot } from '../../ipc/runtime-environments/catalog/runtime-environment-registry-root'
import { acceptEphemeralVmWorkspaceWake } from '../../ephemeral-vm/workspace-resume'
import { registerRecipeVmWaker } from '../workspaces/sleep/recipe-vm-waker-registry'
import {
  isRecipeVmSshTargetAsleep,
  setRecipeVmAsleepStoreRoot
} from '../../ephemeral-vm/recipe-vm-asleep'
import { setSshHostAsleepCheck } from '../../ssh/connection/ssh-host-sleep-hold'
import { ArtifactCloudService } from '../../artifacts/artifact-cloud-service'
import { SkillCloudService } from '../../skills/cloud/skill-cloud-package-service'
import { isArtifactSharingEnabled } from '../../../shared/artifacts/artifact-sharing-gate'

export function desktopWorkspaceSleepPlatform(
  store: Store,
  userDataPath: () => string
): RuntimeConstructionDependencies['workspaceSleepPlatform'] {
  return {
    callEnvironment: async (environmentId, method, params, timeoutMs) => {
      const { callRuntimeEnvironment } =
        await import('../../ipc/runtime-environments/requests/runtime-environment-transport-routing')
      return callRuntimeEnvironment(
        getRuntimeEnvironmentRegistryRoot(),
        environmentId,
        method,
        params,
        timeoutMs
      )
    },
    ownsVm: (workspaceId) =>
      findWorkspaceEphemeralVmRuntime(userDataPath(), workspaceId) !== undefined,
    suspendVm: async (workspaceId) => {
      const { suspendEphemeralVmWorkspace } = await import('../../ephemeral-vm/workspace-suspend')
      return suspendEphemeralVmWorkspace(store, workspaceId)
    },
    acceptWake: (workspaceId) => acceptEphemeralVmWorkspaceWake(workspaceId),
    resumeVm: async (workspaceId, request) => {
      const { resumeEphemeralVmWorkspace } = await import('../../ephemeral-vm/workspace-resume')
      return resumeEphemeralVmWorkspace(store, workspaceId, request)
    }
  }
}

export function installDesktopWorkspaceVmWaker(
  runtime: OrcaRuntimeService,
  userDataPath: () => string
): void {
  // Opening a recipe VM's workspace from a client wakes the VM through the runtime's one owner.
  registerRecipeVmWaker({
    state: (workspaceId, suspended) => runtime.workspaceVmState(workspaceId, suspended),
    noteOpened: (workspaceId) => runtime.noteWorkspaceReopened(workspaceId),
    holdOpen: (workspaceId, suspended, timeoutMs, signal) =>
      runtime.holdWorkspaceVmOpen(workspaceId, suspended, timeoutMs, signal),
    openEnvironment: async (selector) => {
      const root = getRuntimeEnvironmentRegistryRoot()
      const [{ openRecipeVmEnvironment }, environment] = await Promise.all([
        import('../../ipc/runtime-environments/managed-orcad/runtime-environment-recipe-vm-wake'),
        resolveEnvironment(root, selector)
      ])
      return openRecipeVmEnvironment(root, environment)
    }
  })
  // A sleeping VM's SSH host takes no background login until its workspace wakes (#36363).
  setRecipeVmAsleepStoreRoot(getRuntimeEnvironmentRegistryRoot)
  setSshHostAsleepCheck((targetId) => isRecipeVmSshTargetAsleep(userDataPath(), targetId))
}

export function configureDesktopCloudServices(
  runtime: OrcaRuntimeService,
  getSettings: () => ReturnType<Store['getSettings']> | undefined,
  userDataPath: string
): void {
  runtime.setArtifactService(
    new ArtifactCloudService(userDataPath, () => isArtifactSharingEnabled(getSettings()))
  )
  runtime.setSkillCloudService(new SkillCloudService(userDataPath))
}
