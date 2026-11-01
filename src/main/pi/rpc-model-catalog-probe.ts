import { assertStructuredAgentResolutionCurrent } from '../native-chat/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { z } from 'zod'
import { requireLegacyAgentSessionAccountHome } from '../../shared/agent-session-account-home'
import type { resolveCliCommand } from '../../shared/node-cli-command-resolution'
import type { AgentCliVersionReader } from '../agent-cli-version-probe'
import { JsonlRpcAgentConnection } from '../jsonl-rpc/agent-connection'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentCommandSettings } from '../native-chat/structured-agent-command-resolution'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from './rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from './rpc-launch-resolution'
import { piModelOptionId, readPiRpcModelOptions, type PiRpcRequester } from './rpc-options'
import { piRpcModelSchema } from './rpc-protocol'

type PiModelCatalogConnection = PiRpcRequester & { close(): Promise<unknown> }

const discoveryStateSchema = z.object({
  model: piRpcModelSchema.pick({ provider: true, id: true }).nullish(),
  thinkingLevel: z.unknown().optional()
})

export type PiModelCatalogProbeDeps = {
  resolveEnvironment: () => Promise<NodeJS.ProcessEnv>
  /** Refresh once on a missing Pi binary; absent disables retry. */
  refreshEnvironmentAfterMiss?: (askedAt: number) => Promise<void>
  resolveCommandSettings?: () => StructuredAgentCommandSettings
  resolveCommand?: typeof resolveCliCommand
  probeVersion?: AgentCliVersionReader
  connect?: (launch: ProviderProcessLaunch) => PiModelCatalogConnection
  homePath?: string
}

function connectPiModelCatalog(launch: ProviderProcessLaunch): PiModelCatalogConnection {
  const connection: JsonlRpcAgentConnection = new JsonlRpcAgentConnection(launch, {
    // Cancel dialogs after binding; Pi cannot read replies to session_start dialogs before binding.
    onRecord: (frame) => {
      if (
        frame.type === 'extension_ui_request' &&
        (typeof frame.id === 'string' || typeof frame.id === 'number')
      ) {
        void connection
          .send({ type: 'extension_ui_response', id: frame.id, cancelled: true })
          .catch(() => undefined)
      }
    }
  })
  return connection
}

export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const cwd = deps.homePath ?? homedir()
    const { env, command, prefixArgs } = await resolvePiRpcInvocation({
      operation,
      accountDir: requireLegacyAgentSessionAccountHome(accountHome).path,
      resolveEnvironment: deps.resolveEnvironment,
      commandSettings: deps.resolveCommandSettings?.(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss: deps.refreshEnvironmentAfterMiss,
      resolveWorkingDirectory: () => cwd
    })
    assertStructuredAgentResolutionCurrent(operation)
    const release = await checkPiRpcVersion({ command, prefixArgs, cwd, env }, deps.probeVersion)
    assertStructuredAgentResolutionCurrent(operation)
    if (release.status === 'tooOld') {
      throw new Error(`pi at ${command} does not run structured chats`)
    }
    const launch = buildPiRpcLaunch({
      command,
      prefixArgs,
      cwd,
      ...piRpcSessionlessEnvironment(env),
      fullAccess: true
    })
    const success = await runAgentModelCatalogSession(
      () =>
        (deps.connect ?? connectPiModelCatalog)({
          ...launch,
          args: [...launch.args, '--no-session']
        }),
      async (connection): Promise<AgentModelCatalogSuccess> => {
        let configured: AgentModelCatalogSuccess['configured']
        try {
          const state = discoveryStateSchema.safeParse(await connection.request('get_state'))
          if (state.success && state.data.model) {
            configured = {
              model: piModelOptionId(state.data.model.provider, state.data.model.id),
              ...(typeof state.data.thinkingLevel === 'string' && state.data.thinkingLevel
                ? { effort: state.data.thinkingLevel }
                : {})
            }
          }
        } catch {
          // Optional default facts cannot prevent a usable inventory from being discovered.
        }
        assertStructuredAgentResolutionCurrent(operation)
        options?.signal?.throwIfAborted()
        const models = await readPiRpcModelOptions(connection)
        return { models, origin: 'probe', ...(configured ? { configured } : {}) }
      },
      { label: 'pi', signal: options?.signal }
    )
    if (success.models.length === 0) {
      throw new Error('pi listed no models')
    }
    return success
  }
}
