import { createCodexRuntimeHomeLaunchPreparation } from '../../codex/configuration/homes/codex-runtime-home-launch-preparation'
import { mainProcessState as state } from '../main-process-state'

export const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
  getRuntimeHome: () => state.core.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

/** Launch preparation and side-effect-free catalog reads must resolve one account-home key. */
export const codexStructuredLaunchHomeResolvers = {
  prepareCodexStructuredLaunch: ({
    launchEnv,
    workspaceId
  }: {
    launchEnv: NodeJS.ProcessEnv
    workspaceId?: string
  }) => prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, { workspaceId }),
  // Throw like preparation: null would silently key the catalog to the system home instead of the account.
  resolveCodexStructuredLaunchHome: ({ launchEnv, workspaceId }: { launchEnv: NodeJS.ProcessEnv; workspaceId?: string }) => {
    const runtimeHome = state.core.codexRuntimeHome
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    return runtimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv, workspaceId)
  }
}
