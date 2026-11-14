import { createCodexRuntimeHomeLaunchPreparation } from '../../codex/configuration/homes/codex-runtime-home-launch-preparation'
import { mainProcessState as state } from '../main-process-state'

export const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

/** Launch preparation and side-effect-free catalog reads must resolve one account-home key. */
export const codexStructuredLaunchHomeResolvers = {
  prepareCodexStructuredLaunch: ({
    launchEnv,
    worktreeId
  }: {
    launchEnv: NodeJS.ProcessEnv
    worktreeId?: string
  }) => prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, worktreeId ? { worktreeId } : {}),
  // Throw like preparation: null would silently key the catalog to the system home instead of the account.
  resolveCodexStructuredLaunchHome: ({
    launchEnv,
    worktreeId
  }: {
    launchEnv: NodeJS.ProcessEnv
    worktreeId?: string
  }) => {
    const runtimeHome = state.codexRuntimeHome
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    return runtimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv, worktreeId)
  }
}
