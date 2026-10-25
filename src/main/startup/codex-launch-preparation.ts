import { createCodexRuntimeHomeLaunchPreparation } from '../codex/codex-runtime-home-launch-preparation'
import { mainProcessState as state } from './main-process-state'

export const prepareCodexRuntimeHomeForLaunch = createCodexRuntimeHomeLaunchPreparation({
  getRuntimeHome: () => state.codexRuntimeHome,
  getSettings: () => state.store?.getSettings()
})

/** The runtime's structured Codex home resolvers: a launch prepares the home that a record-less
 *  catalog read resolves without side effects, so a new chat's picker and the chat share one key. */
export const codexStructuredLaunchHomeResolvers = {
  prepareCodexStructuredLaunch: ({ launchEnv }: { launchEnv: NodeJS.ProcessEnv }) =>
    prepareCodexRuntimeHomeForLaunch(undefined, launchEnv),
  // Why throw like prepare does: a null from an uninitialized service would
  // map to the system home and key a catalog read to the wrong account.
  resolveCodexStructuredLaunchHome: ({ launchEnv }: { launchEnv: NodeJS.ProcessEnv }) => {
    const runtimeHome = state.codexRuntimeHome
    if (!runtimeHome) {
      throw new Error('Codex runtime home service is not initialized')
    }
    return runtimeHome.resolveHostCodexHomePathForLaunchReadOnly(launchEnv)
  }
}
