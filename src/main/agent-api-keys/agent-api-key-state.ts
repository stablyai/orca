import type {
  AgentApiKeysMutationResult,
  AgentApiKeysState
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import type { AgentApiKeyCloudOutcome } from '../../shared/agent-api-keys/agent-api-key-cloud'
import type { AgentApiKeyCloudSync } from './agent-api-key-cloud-sync'
import { AgentApiKeyError, type AgentApiKeyStore } from './agent-api-key-store'

export async function stateOf(
  store: AgentApiKeyStore,
  cloud: AgentApiKeyCloudSync
): Promise<AgentApiKeysState> {
  const keys = await store.list()
  return {
    keys,
    protection: store.protection(),
    cloud: await cloud.state(keys)
  }
}

export async function mutate(
  store: AgentApiKeyStore,
  cloud: AgentApiKeyCloudSync,
  run: () => Promise<AgentApiKeyCloudOutcome | void>
): Promise<AgentApiKeysMutationResult> {
  try {
    const outcome = await run()
    return {
      ok: true,
      state: await stateOf(store, cloud),
      ...(outcome ? { cloud: outcome } : {})
    }
  } catch (error) {
    // Only our own messages reach the renderer: anything else could quote a value.
    const message =
      error instanceof AgentApiKeyError ? error.message : 'Orca could not save the key.'
    return { ok: false, error: message, state: await stateOf(store, cloud) }
  }
}
