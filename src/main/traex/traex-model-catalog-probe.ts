import { homedir } from 'node:os'
import type { AgentModelCatalogProbe } from '../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import { runAgentModelCatalogSession } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { StructuredAgentModelCatalogContext } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { TraexAppServerConnection } from './traex-app-server-connection'
import { readTraexModelCatalog } from './traex-model-catalog'
import { resolveTraexReadLaunch } from './traex-launch-resolution'
import { traexRecord, traexText } from './traex-protocol'

export function createTraexModelCatalogProbe(
  context: StructuredAgentModelCatalogContext
): AgentModelCatalogProbe {
  return async (accountHome, options) => {
    const cwd = options?.workspacePath ?? homedir()
    const launch = await resolveTraexReadLaunch(
      context,
      accountHome,
      cwd,
      options?.operation ?? { signal: options?.signal }
    )
    return runAgentModelCatalogSession(
      () => new TraexAppServerConnection(launch),
      async (connection) => {
        await connection.initialize()
        const { models } = await readTraexModelCatalog(connection)
        const settings = await connection
          .request('config/read', { includeLayers: false, cwd })
          .catch(() => null)
        const config = traexRecord(traexRecord(settings).config)
        const model = traexText(config.model)
        const effort = traexText(config.model_reasoning_effort)
        return {
          models,
          origin: 'probe',
          complete: true,
          ...(model ? { configured: { model, ...(effort ? { effort } : {}) } } : {})
        }
      },
      { label: 'trae', signal: options?.signal }
    )
  }
}
