import { assertStructuredAgentResolutionCurrent } from '../native-chat/structured-agent-command-resolution'
import { homedir } from 'node:os'
import { z } from 'zod'
import type {
  AgentModelCatalogProbe,
  AgentModelCatalogSuccess
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { runPiRpcCatalogSession, type PiRpcCatalogSessionDeps } from './rpc-catalog-session'
import { piModelOptionId, readPiRpcModelOptions } from './rpc-options'
import { piRpcModelSchema } from './rpc-protocol'

const discoveryStateSchema = z.object({
  model: piRpcModelSchema.pick({ provider: true, id: true }).nullish(),
  thinkingLevel: z.unknown().optional()
})

export type PiModelCatalogProbeDeps = PiRpcCatalogSessionDeps & { homePath?: string }

/** Discover available models and configured defaults without creating a Pi conversation. */
export function createPiModelCatalogProbe(deps: PiModelCatalogProbeDeps): AgentModelCatalogProbe {
  return async (accountHome, options): Promise<AgentModelCatalogSuccess> => {
    const operation = options?.operation ?? { signal: options?.signal }
    assertStructuredAgentResolutionCurrent(operation)
    const cwd = deps.homePath ?? homedir()
    const success = await runPiRpcCatalogSession(
      deps,
      { accountHome, cwd, operation, signal: options?.signal },
      async (connection): Promise<AgentModelCatalogSuccess> => {
        let configured: AgentModelCatalogSuccess['configured']
        let unknownProvider = false
        try {
          const state = discoveryStateSchema.safeParse(await connection.request('get_state'))
          unknownProvider = state.success && state.data.model?.provider === 'unknown'
          if (state.success && state.data.model && !unknownProvider) {
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
        // Pi's own "No models available" condition: no selected provider and nothing listable.
        const models = await readPiRpcModelOptions(connection).catch((error: unknown) => {
          if (unknownProvider) {
            throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
          }
          throw error
        })
        if (unknownProvider && models.length === 0) {
          throw new AgentModelCatalogUnavailableError({ reason: 'notSignedIn' })
        }
        return { models, origin: 'probe', ...(configured ? { configured } : {}) }
      }
    )
    if (success.models.length === 0) {
      throw new Error('pi listed no models')
    }
    return success
  }
}
