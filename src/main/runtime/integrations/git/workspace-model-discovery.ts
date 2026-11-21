import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../../../providers/execution-host-provider-dispatch'
import { discoverCommitMessageModelsLocal } from '../../../text-generation/commit-message-text-generation'
import { discoverModelsWithHostCache } from '../../../text-generation/models/model-discovery-host-cache'
import type { DiscoverCommitMessageModelsResult } from '../../../text-generation/source-control-text-generation-types'
import type { ModelDiscoveryWorkspace } from './runtime-git-command-target'
import {
  discoverModelsOverSsh,
  runSshModelProbe,
  sshProbeIsWindows,
  type RemoteModelProbe,
  type SshModelProbeHooks
} from './ssh-workspace-model-probe'

export type { RemoteModelProbe, SshModelProbeHooks }

export type WorkspaceModelDiscoveryDeps = {
  discoverLocal?: typeof discoverCommitMessageModelsLocal
  runRemoteProbe?: (
    connectionId: string,
    command: string,
    stdin: string | null
  ) => Promise<RemoteModelProbe>
  sshProbe?: SshModelProbeHooks
}

/** Lists models where the workspace's terminal runs: this machine, WSL, or its SSH host. */
export function discoverModelsForWorkspace(
  input: {
    agentId: TuiAgent
    workspace: ModelDiscoveryWorkspace
    env?: NodeJS.ProcessEnv
    launchEnv?: NodeJS.ProcessEnv
    accountPatch?: Record<string, string>
    agentCommandOverride?: string
  },
  deps: WorkspaceModelDiscoveryDeps = {}
): Promise<DiscoverCommitMessageModelsResult> {
  const route = resolveGitRouteForHost(input.workspace.executionHostId)
  if (route.kind === 'runtime') {
    return Promise.reject(new ExecutionHostNotDispatchableError(route.hostId))
  }
  if (route.kind === 'local') {
    const discoverLocal = deps.discoverLocal ?? discoverCommitMessageModelsLocal
    return discoverLocal(input.agentId, input.env, input.agentCommandOverride, {
      cwd: input.workspace.path,
      ...(input.workspace.wslDistro ? { wslDistro: input.workspace.wslDistro } : {}),
      ...(input.launchEnv ? { launchEnv: input.launchEnv } : {}),
      ...(input.accountPatch ? { accountPatch: input.accountPatch } : {})
    })
  }
  const connectionId = route.connectionId
  const runRemoteProbe =
    deps.runRemoteProbe ??
    ((id: string, command: string, stdin: string | null) =>
      runSshModelProbe(id, command, stdin, deps.sshProbe))
  // The host cache coalesces SSH probes and drops them on agent refresh; errors stay uncached.
  return discoverModelsWithHostCache(
    {
      agentId: input.agentId,
      agentCommandOverride: input.agentCommandOverride,
      env: input.env,
      launchEnv: input.launchEnv,
      accountPatch: input.accountPatch,
      options: { cwd: input.workspace.path },
      connectionId
    },
    () =>
      discoverModelsOverSsh({
        agentId: input.agentId,
        cwd: input.workspace.path,
        connectionId,
        env: input.env,
        agentCommandOverride: input.agentCommandOverride,
        windows: sshProbeIsWindows(connectionId, deps.sshProbe),
        runRemoteProbe
      })
  )
}
