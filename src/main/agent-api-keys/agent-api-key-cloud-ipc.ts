// IPC for the Orca account side of Agent API keys: save one existing key there, and "Import from
// this Mac". Nothing here returns a value; scans answer with names, sources and last fours.
import { ipcMain } from 'electron'
import type {
  AgentApiKeyRemoveRequest,
  AgentApiKeysImportResult,
  AgentApiKeysScanResult
} from '../../shared/agent-api-keys/agent-api-key-cloud'
import type { AgentApiKeysMutationResult } from '../../shared/agent-api-keys/agent-api-key-catalog'
import { resolveLoginShellEnvironment } from '../startup/shell-environment/login-shell-environment'
import type { AgentApiKeyCloudSync } from './agent-api-key-cloud-sync'
import { importLocalAgentKeys, parseImportNames, scanSummary } from './agent-api-key-import'
import { mutate, stateOf } from './agent-api-key-state'
import type { AgentApiKeyStore } from './agent-api-key-store'
import { readLocalAgentCredentials, type LocalAgentCredentials } from './local-agent-credentials'

const CHANNELS = [
  'agentApiKeys:saveToAccount',
  'agentApiKeys:scanThisComputer',
  'agentApiKeys:importFromThisComputer'
] as const

/** `remove` takes a bare id (keep the account copy) or `{ id, fromAccount }`. */
export function removeRequestOf(raw: unknown): AgentApiKeyRemoveRequest | null {
  if (typeof raw === 'string') {
    return { id: raw, fromAccount: false }
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'id' in raw &&
    typeof raw.id === 'string' &&
    'fromAccount' in raw &&
    typeof raw.fromAccount === 'boolean'
  ) {
    return { id: raw.id, fromAccount: raw.fromAccount }
  }
  return null
}

/** What an agent started from a terminal here would see: the login shell's env over Orca's own. */
async function readThisComputer(): Promise<LocalAgentCredentials> {
  let shellEnv: NodeJS.ProcessEnv = {}
  try {
    shellEnv = await resolveLoginShellEnvironment()
  } catch {
    // No login shell (or it timed out): Orca's own env and the agents' files still count.
  }
  return await readLocalAgentCredentials({ env: { ...process.env, ...shellEnv } })
}

export function registerAgentApiKeyCloudHandlers({
  store,
  cloud,
  serial,
  read = readThisComputer
}: {
  store: AgentApiKeyStore
  cloud: AgentApiKeyCloudSync
  serial: <T>(run: () => Promise<T>) => Promise<T>
  read?: () => Promise<LocalAgentCredentials>
}): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  // One explicit click: writes a key that is only on this computer to the Orca account.
  ipcMain.handle(
    'agentApiKeys:saveToAccount',
    (_event, id: unknown): Promise<AgentApiKeysMutationResult> =>
      serial(() =>
        mutate(store, cloud, async () => {
          const key =
            typeof id === 'string' ? (await store.list()).find((entry) => entry.id === id) : null
          return key ? cloud.push(key, { replace: true }) : { kind: 'failed', error: 'not_found' }
        })
      )
  )
  ipcMain.handle('agentApiKeys:scanThisComputer', async (): Promise<AgentApiKeysScanResult> =>
    scanSummary(await read(), await store.list())
  )
  ipcMain.handle(
    'agentApiKeys:importFromThisComputer',
    async (_event, raw: unknown): Promise<AgentApiKeysImportResult> => {
      const names = parseImportNames(raw)
      // Read outside the queue: a slow shell or file must not hold up saves and removals.
      const found = names ? await read() : null
      return serial(async () => {
        const result =
          names && found
            ? await importLocalAgentKeys({ names, found, store, push: (key) => cloud.push(key) })
            : { imported: [], failed: [], cloudFailed: [] }
        return { ...result, state: await stateOf(store, cloud) }
      })
    }
  )
}
