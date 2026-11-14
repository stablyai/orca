import { agentModelCatalogInputStamp } from '../../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation,
  type StructuredAgentCommandSettings
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { z } from 'zod'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { resolveCliCommand } from '../../../../shared/node-cli-command-resolution'
import {
  readAgentCliVersion,
  type AgentCliVersionReader
} from '../../../agent-launch/preflight/agent-cli-version-probe'
import { JsonlRpcAgentConnection } from '../../../jsonl-rpc/agent-connection'
import type {
  AgentModelCatalogProgress,
  AgentModelCatalogProbe,
  AgentModelCatalogLookup
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { runAgentModelCatalogSession } from '../../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { AgentModelCatalogUnavailableError } from '../../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import type { ProviderProcessLaunch } from '../../../provider-process/provider-process-launch'
import { buildPiRpcLaunch, piRpcSessionlessEnvironment } from '../launch/rpc-launch'
import { checkPiRpcVersion, resolvePiRpcInvocation } from '../launch/rpc-launch-resolution'
import { piModelOptionId, readPiRpcModelOptions, type PiRpcRequester } from './rpc-model-options'
import { piRpcModelSchema } from './rpc-model-schema'

type PiModelCatalogConnection = PiRpcRequester & { close(): Promise<unknown> }

const discoveryStateSchema = z.object({
  model: piRpcModelSchema.pick({ provider: true, id: true }).nullish(),
  thinkingLevel: z.unknown().optional()
})

export type PiModelCatalogProbeDeps = {
  resolveSavedEnvironment?: () => Promise<NodeJS.ProcessEnv>
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
  const resolve = async (
    accountHome: Parameters<AgentModelCatalogProbe>[0],
    _workspace: string,
    lookup: AgentModelCatalogLookup = 'recover',
    operation?: StructuredAgentResolutionOperation
  ) => {
    assertStructuredAgentResolutionCurrent(operation)
    const cwd = deps.homePath ?? homedir()
    const { env, command, prefixArgs } = await resolvePiRpcInvocation({
      operation,
      accountDir: requireLegacyAgentSessionAccountHome(accountHome).path,
      resolveEnvironment:
        lookup === 'recover'
          ? deps.resolveEnvironment
          : (deps.resolveSavedEnvironment ?? deps.resolveEnvironment),
      commandSettings: deps.resolveCommandSettings?.(),
      resolveCommand: deps.resolveCommand,
      refreshEnvironmentAfterMiss:
        lookup === 'recover' ? deps.refreshEnvironmentAfterMiss : undefined,
      resolveWorkingDirectory: () => cwd
    })
    assertStructuredAgentResolutionCurrent(operation)
    return {
      identity: { command, prefixArgs, cwd },
      inputStamp: await agentModelCatalogInputStamp({ command, prefixArgs, cwd, env }),
      run: async (
        signal?: AbortSignal,
        runOperation = operation,
        _selectedModels?: readonly string[],
        publish?: AgentModelCatalogProgress
      ): Promise<AgentModelCatalogSuccess> => {
        const operation = runOperation
        const options = { signal }
        assertStructuredAgentResolutionCurrent(operation)
        const release = await checkPiRpcVersion(
          { command, prefixArgs, cwd, env, operation },
          deps.probeVersion ?? ((input) => readAgentCliVersion({ ...input, timeoutMs: null }))
        )
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
            let unknownProvider = false
            let stateKnown = false
            let models: AgentModelCatalogSuccess['models'] | undefined
            const progress = () => {
              assertStructuredAgentResolutionCurrent(operation)
              if (models?.length) {
                publish?.(
                  { models, origin: 'probe', ...(configured ? { configured } : {}) },
                  stateKnown
                )
              }
            }
            const state = connection
              .request('get_state', undefined, { timeoutMs: null })
              .catch(() => undefined)
              .then((response) => {
                assertStructuredAgentResolutionCurrent(operation)
                const parsed = discoveryStateSchema.safeParse(response)
                stateKnown = parsed.success
                unknownProvider = parsed.success && parsed.data.model?.provider === 'unknown'
                if (parsed.success && parsed.data.model && !unknownProvider) {
                  configured = {
                    model: piModelOptionId(parsed.data.model.provider, parsed.data.model.id),
                    ...(typeof parsed.data.thinkingLevel === 'string' && parsed.data.thinkingLevel
                      ? { effort: parsed.data.thinkingLevel }
                      : {})
                  }
                }
                progress()
              })
            void state.catch(() => {})
            try {
              models = await readPiRpcModelOptions(connection, { timeoutMs: null })
            } catch (error) {
              await state
              if (unknownProvider) {
                throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
              }
              throw error
            }
            progress()
            await state
            assertStructuredAgentResolutionCurrent(operation)
            options.signal?.throwIfAborted()
            if (unknownProvider && models.length === 0) {
              throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
            }
            return { models, origin: 'probe', ...(configured ? { configured } : {}) }
          },
          { label: 'pi', signal: options?.signal, timeoutMs: null }
        )
        if (success.models.length === 0) {
          throw new Error('pi listed no models')
        }
        return success
      }
    }
  }
  return Object.assign<AgentModelCatalogProbe, Pick<AgentModelCatalogProbe, 'resolve'>>(
    async (home, options) =>
      (await resolve(home, '', 'recover', options?.operation)).run(
        options?.signal,
        options?.operation,
        options?.selectedModels,
        options?.publish
      ),
    { resolve }
  )
}
