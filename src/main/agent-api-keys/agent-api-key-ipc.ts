import { ipcMain } from 'electron'
import { join } from 'node:path'
import type {
  AgentApiKeySaveRequest,
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import { AgentApiKeyError, AgentApiKeyStore } from './agent-api-key-store'
import { installAgentApiKeyLaunchEnvResolver } from './agent-api-key-launch-env'

const CHANNELS = ['agentApiKeys:list', 'agentApiKeys:save', 'agentApiKeys:remove'] as const

function stateOf(store: AgentApiKeyStore): AgentApiKeysState {
  return { keys: store.list(), protection: store.protection() }
}

function mutate(store: AgentApiKeyStore, run: () => void): AgentApiKeysMutationResult {
  try {
    run()
    return { ok: true, state: stateOf(store) }
  } catch (error) {
    // Only our own messages reach the renderer: anything else could quote a value.
    const message =
      error instanceof AgentApiKeyError ? error.message : 'Orca could not save the key.'
    return { ok: false, error: message, state: stateOf(store) }
  }
}

/** Values only ever travel renderer → main here; nothing returns them. */
export function registerAgentApiKeyHandlers(userDataPath: string): AgentApiKeyStore {
  const store = new AgentApiKeyStore(join(userDataPath, 'agent-api-keys.json'))
  installAgentApiKeyLaunchEnvResolver((agent, hostId) => store.launchEnv(agent, hostId))
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('agentApiKeys:list', () => stateOf(store))
  ipcMain.handle('agentApiKeys:save', (_event, request: AgentApiKeySaveRequest) =>
    mutate(store, () => {
      store.save(request)
    })
  )
  ipcMain.handle('agentApiKeys:remove', (_event, id: unknown) =>
    mutate(store, () => {
      if (typeof id === 'string') {
        store.remove(id)
      }
    })
  )
  return store
}
