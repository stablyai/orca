import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registration-types'
import { readPiRpcSessionOptions } from '../pi/rpc-options'
import { readOmpFastOptions } from './rpc-options'
import { runOmpRpcCatalogSession } from './rpc-catalog-session'

export function createOmpRpcModelCatalogProbe(
  context: StructuredAgentModelCatalogContext
): AgentModelCatalogProbe {
  const probe: AgentModelCatalogProbe = async (account, request) => {
    const cwd = request?.workspacePath
    if (!cwd) {
      throw new Error('OMP lists models in the chat folder')
    }
    return runOmpRpcCatalogSession(
      context,
      account,
      {
        kind: 'model',
        cwd,
        operation: request?.operation ?? { signal: request?.signal }
      },
      async (connection) => {
        const options = await readOmpFastOptions(
          connection,
          await readPiRpcSessionOptions(connection)
        )
        const models = options.models.map((model) => ({
          ...model,
          isDefault: model.id === options.current.model,
          ...(model.id === options.current.model && options.current.effort
            ? { defaultEffort: options.current.effort }
            : {})
        }))
        if (!models.length) {
          throw new Error('OMP listed no models')
        }
        return {
          models,
          origin: 'probe' as const,
          fastModeSupport: options.fastModeSupport,
          configured: options.current
        }
      }
    )
  }
  probe.sessionless = true
  return probe
}
