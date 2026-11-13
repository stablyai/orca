import { resolveHostAgentBaseEnvironment } from '../../agent-session/environment/structured-agent-shell-environment'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import { resolveAgentTerminalDiscoveryLaunch } from '../launch/agent-launch-scope-runtime'
import { peekAntigravityModels } from '../../../text-generation/models/model-discovery-host-cache'

/** The destination's existing discovery context is the only inventory a launch may borrow. */
export async function cachedAntigravityLaunchModels(
  store: RuntimeStore,
  scope: TerminalWorkspaceLaunchScope,
  context: {
    cwd?: string
    env?: Readonly<Record<string, string>>
    accountEnv?: Readonly<Record<string, string>>
    envToDelete?: readonly string[]
    shellOverride?: string
  }
) {
  if (
    scope.connectionId ||
    context.env ||
    context.accountEnv ||
    context.shellOverride ||
    context.envToDelete?.length
  ) {
    return undefined
  }
  try {
    const launch = await resolveAgentTerminalDiscoveryLaunch(
      store,
      scope,
      'antigravity',
      context.cwd
    )
    return peekAntigravityModels({
      agentId: 'antigravity',
      agentCommandOverride: launch.command,
      env: launch.wslDistro
        ? undefined
        : await resolveHostAgentBaseEnvironment(store.getSettings(), true),
      options: {
        cwd: launch.cwd,
        wslDistro: launch.wslDistro,
        agentEnv: launch.agentEnv,
        useCwdForNative: true
      }
    })
  } catch {
    return undefined
  }
}
