import { setTimeout as delay } from 'node:timers/promises'
import { observeAcpForkSupport } from '../capabilities/acp-fork-support'
import {
  assertStructuredAgentResolutionCurrent,
  type StructuredAgentResolutionOperation
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
import type { AcpSessionModelDiscovery } from './acp-model-discovery-policy'
import type { AcpLaunchSpec } from '../launch/acp-launch-contract'
import type { AcpSessionStarted, AcpSessionStartOptions } from '../protocol/acp-session-setup'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import type {
  InitializeResponse,
  SetSessionConfigOptionResponse
} from '../generated/acp-protocol.generated'
import type { AgentModelCatalogReady } from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import type { AgentModelCatalogProgress } from '../../native-chat/agent-model-catalog/agent-model-catalog-discovery'
import { AcpAgentError } from '../transport/acp-errors'

/** Session-free capability boundary: no session methods are exposed. */
export type AcpModelCatalogConnection = {
  initialize(): Promise<InitializeResponse>
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
  close(): Promise<unknown>
}

export type AcpModelCatalogSessionConnection = Omit<
  AcpModelCatalogConnection,
  'requestSessionFreeExtension'
> & {
  start(options: AcpSessionStartOptions): Promise<AcpSessionStarted>
  setConfigOption(configId: string, value: string): Promise<SetSessionConfigOptionResponse>
  deleteSession(sessionId: string): Promise<unknown>
}

// OpenCode can answer -32603 while its providers are still opening; a later attempt lists them.
async function startListingSession(
  connection: AcpModelCatalogSessionConnection,
  workspace: string,
  operation?: StructuredAgentResolutionOperation
): Promise<AcpSessionStarted> {
  for (const backoffMs of [250, 500]) {
    try {
      return await connection.start({ cwd: workspace, mcpServers: [] })
    } catch (error) {
      if (!(error instanceof AcpAgentError && error.code === -32603)) {
        throw error
      }
    }
    await delay(backoffMs, undefined, { signal: operation?.signal })
    assertStructuredAgentResolutionCurrent(operation)
  }
  return connection.start({ cwd: workspace, mcpServers: [] })
}

/** Lists models from a disposable session, learning menus for the models it starts on or switches to. */
export async function readSessionModels(
  spec: AcpLaunchSpec,
  listing: AcpSessionModelDiscovery,
  connection: AcpModelCatalogSessionConnection,
  workspace: string,
  operation?: StructuredAgentResolutionOperation,
  selectedModels?: readonly string[],
  launchedModel?: string,
  ready?: AgentModelCatalogReady<{ models: AgentSessionModelOption[]; attemptedModels: string[] }>,
  publish?: (result: { models: AgentSessionModelOption[]; attemptedModels: string[] }) => void,
  deferred?: {
    defer: (
      read: () => { models: AgentSessionModelOption[]; attemptedModels: string[] },
      known: (model: string) => boolean
    ) => void
    demanded: NonNullable<AgentModelCatalogProgress['demanded']>
  }
): Promise<{ models: AgentSessionModelOption[]; attemptedModels: string[] }> {
  const initialized = await connection.initialize()
  assertStructuredAgentResolutionCurrent(operation)
  observeAcpForkSupport(spec.agent, initialized)
  const deletes = Boolean(initialized.agentCapabilities?.sessionCapabilities?.delete)
  if (!deletes && !listing.sessionFolderArgs) {
    throw new Error(`${spec.agent} cannot delete a session, so it lists its models only in chats`)
  }
  const started = await startListingSession(connection, workspace, operation)
  let stopped = false
  const cleanup = async (): Promise<void> => {
    stopped = true
    if (deletes) {
      await connection.deleteSession(started.sessionId).catch((error: unknown) => {
        console.warn(`[acp-model-catalog] ${spec.agent} kept its listing session:`, error)
      })
    }
  }
  const options = new AcpStructuredOptions(spec.dialect)
  options.adoptSession(started.response, 'new')
  let models = [...options.read().models]
  const attemptedModels: string[] = []
  const partial = () => {
    stopped = true
    return { models: [...models], attemptedModels: [...attemptedModels] }
  }
  ready?.(cleanup, models.length > 0 ? partial : undefined)
  const progress = () => publish?.({ models: [...models], attemptedModels: [...attemptedModels] })
  try {
    if (launchedModel !== undefined) {
      attemptedModels.push(launchedModel)
      const running = options.read().current.model
      // An unresolved --model leaves OMP on its default with a menu that is not that model's.
      if (running !== launchedModel) {
        models = models.map((row) =>
          row.id === running ? { ...row, efforts: [], effortsKnown: false as const } : row
        )
      }
      progress()
    } else if (spec.dialect.effortChangesModel) {
      progress()
      const indices = new Map(models.map((model, index) => [model.id, index]))
      const remaining = new Set(selectedModels ?? models.map((model) => model.id))
      const visited = new Set<string>()
      const known = (id: string) => {
        const index = indices.get(id)
        return index !== undefined && models[index].effortsKnown !== false
      }
      const snapshot = () => ({ models: [...models], attemptedModels: [...attemptedModels] })
      while (!stopped) {
        const demanded = deferred?.demanded() ?? new Set(selectedModels)
        for (const id of demanded) {
          if (!visited.has(id) && indices.has(id)) {
            remaining.add(id)
          }
        }
        const id = [...demanded].find((id) => remaining.has(id)) ?? remaining.values().next().value
        if (id === undefined) {
          break
        }
        remaining.delete(id)
        visited.add(id)
        const index = indices.get(id)
        if (index === undefined || known(id)) {
          continue
        }
        assertStructuredAgentResolutionCurrent(operation)
        let conclusive = false
        try {
          for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
            const write = options.write('model', id)
            if (write?.method !== 'config') {
              conclusive = true
              break
            }
            const reply = await connection.setConfigOption(write.configId, write.value)
            if (stopped) {
              break
            }
            assertStructuredAgentResolutionCurrent(operation)
            options.adoptConfigOptions(reply.configOptions)
            const observed = options.read()
            if (observed.current.model !== id) {
              continue
            }
            const learned = observed.models.find((row) => row.id === id)
            if (learned) {
              models[index] = learned
            }
            conclusive = true
            break
          }
        } catch {
          assertStructuredAgentResolutionCurrent(operation)
          conclusive = true
        }
        if (conclusive) {
          attemptedModels.push(id)
        }
        if (deferred?.demanded().has(id)) {
          progress()
        } else if (deferred) {
          deferred.defer(snapshot, known)
        } else {
          progress()
        }
      }
      stopped = true
    }
    return { models, attemptedModels }
  } finally {
    if (!ready) {
      await cleanup()
    }
  }
}
