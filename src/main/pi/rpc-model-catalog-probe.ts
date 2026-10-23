import { homedir } from 'node:os'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from './rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from './rpc-launch-resolution'
import { piModelCatalogFromRpc, type PiRpcRequester } from './rpc-options'

export type PiModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Rereads that environment when Pi is not found in it; absent never retries. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  /** Test seams; production uses the shared supervised RPC connection. */
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => PiRpcRequester & { close(): Promise<unknown> }
  homePath?: string
}

/** Reads Pi's runtime inventory in a disposable, sessionless RPC child. */
export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const cwd = options?.workspacePath ?? deps.homePath ?? homedir()
    const { env, command } = await resolvePiRpcInvocation({
      accountDir: requireLegacyAgentSessionAccountHome(accountHome).path,
      resolveEnvironment: deps.resolveEnvironment,
      commandSettings: deps.resolveCommandSettings?.(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
      resolveWorkingDirectory: () => cwd
    })
    if ((await checkPiRpcVersion({ command, cwd, env }, deps.probeVersion)).status === 'tooOld') {
      throw new Error(`pi at ${command} does not run structured chats`)
    }
    const launch = buildPiRpcLaunch({
      command,
      cwd,
      ...piRpcSessionlessEnvironment(env),
      fullAccess: true
    })
    const models = await runAgentModelCatalogSession(
      () => {
        const discovery = { ...launch, args: [...launch.args, '--no-session'] }
        return deps.connect?.(discovery) ?? new JsonlRpcAgentConnection(discovery)
      },
      async (connection) => piModelCatalogFromRpc(await connection.request('get_available_models')),
      { label: 'pi', signal: options?.signal }
    )
    if (models.length === 0) {
      throw new Error('pi listed no models')
    }
    return { models, origin: 'probe' }
  }
}
