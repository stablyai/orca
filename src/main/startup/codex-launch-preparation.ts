import { createCodexRuntimeHomeLaunchPreparation } from '../codex/codex-runtime-home-launch-preparation'
import { mainProcessState as state } from './main-process-state'

export const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

/** Launch preparation and side-effect-free catalog reads must resolve one account-home key. */
export const codexStructuredLaunchHomeResolvers = {
  prepareCodexStructuredLaunch: ({
    launchEnv,
    conversationHome
  }: {
    launchEnv: NodeJS.ProcessEnv
    conversationHome?: string
  }) => prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, { conversationHome }),
  // Throw like preparation: null would silently key the catalog to the system home instead of the account.
  resolveCodexStructuredLaunchHome: ({
    launchEnv,
    conversationHome
  }: {
    launchEnv: NodeJS.ProcessEnv
    conversationHome?: string
  }) => {
    const runtimeHome = state.codexRuntimeHome
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    return runtimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv, conversationHome)
  }
}
