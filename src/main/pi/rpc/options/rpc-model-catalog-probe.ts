import { agentModelCatalogInputStamp } from '../../../native-chat/agent-model-catalog/agent-model-catalog-input-stamp'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { z } from 'zod'
import { requireLegacyAgentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { readAgentCliVersion } from '../../../agent-launch/preflight/agent-cli-version-probe'
import type {
  AgentModelCatalogProgress,
  AgentModelCatalogProbe,
  AgentModelCatalogLookup
} from '../../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import type { AgentModelCatalogSuccess } from '../../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { AgentModelCatalogUnavailableError } from '../../../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { resolvePiRpcInvocation } from '../launch/rpc-launch-resolution'
import { piModelOptionId, readPiRpcModelOptions } from './rpc-model-options'
import { piRpcModelSchema } from './rpc-model-schema'
import { runResolvedPiRpcCatalogSession, type PiRpcCatalogSessionDeps } from './rpc-catalog-session'

const discoveryStateSchema = z.object({
  model: piRpcModelSchema.pick({ provider: true, id: true }).nullish(),
  thinkingLevel: z.unknown().optional()
})

export type PiModelCatalogProbeDeps = PiRpcCatalogSessionDeps & {
  resolveSavedEnvironment?: () => Promise<NodeJS.ProcessEnv>
  homePath?: string
}

/** Discover available models and configured defaults without creating a Pi conversation. */
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
        const success = await runResolvedPiRpcCatalogSession(
          {
            ...deps,
            probeVersion:
              deps.probeVersion ?? ((input) => readAgentCliVersion({ ...input, timeoutMs: null }))
          },
          { command, prefixArgs, cwd, env, operation },
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
          { signal: options?.signal, timeoutMs: null }
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
