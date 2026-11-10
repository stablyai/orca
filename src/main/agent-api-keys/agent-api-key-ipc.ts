import { BrowserWindow, ipcMain, powerMonitor } from 'electron'
import { join } from 'node:path'
import {
  selectAgentApiKeys,
  type AgentApiKeySaveRequest
} from '../../shared/agent-api-keys/agent-api-key-catalog'
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import { AgentApiKeyStore } from './agent-api-key-store'
import { mutate, stateOf } from './agent-api-key-state'
import { installAgentApiKeyLaunchEnvResolver } from './agent-api-key-launch-env'
import { AgentApiKeyCloudSync } from './agent-api-key-cloud-sync'
import { agentApiKeyCloudLink, setAgentApiKeyCloudRecorder } from './agent-api-key-cloud-connection'
import {
  createAgentApiKeyCloudRetry,
  type AgentApiKeyCloudRetry
} from './agent-api-key-cloud-retry'
import { registerAgentApiKeyCloudHandlers, removeRequestOf } from './agent-api-key-cloud-ipc'

/** A host id no host-scoped key names, as in desktopKeyValueForCloud. */
const ANY_CLOUD_HOST = toRuntimeExecutionHostId('orca-cloud')

const CHANNELS = ['agentApiKeys:list', 'agentApiKeys:save', 'agentApiKeys:remove'] as const

let retry: AgentApiKeyCloudRetry | null = null
let wakeHooked = false

/** Values only ever travel renderer → main here; nothing returns them. */
export function registerAgentApiKeyHandlers(userDataPath: string): AgentApiKeyStore {
  const store = new AgentApiKeyStore(join(userDataPath, 'agent-api-keys.json'))
  const cloud = new AgentApiKeyCloudSync({
    ledgerPath: join(userDataPath, 'agent-api-keys-cloud-ledger.json'),
    link: agentApiKeyCloudLink,
    valueOf: (id) => store.valueOf(id),
    listKeys: () => store.list(),
    onWaiting: () => retry?.kick()
  })
  // Saves, removals and imports touch the vault and the ledger; one at a time keeps them in step.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }
  installAgentApiKeyLaunchEnvResolver((agent, hostId) => store.launchEnv(agent, hostId))
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('agentApiKeys:list', () => stateOf(store, cloud))
  ipcMain.handle('agentApiKeys:save', (_event, request: AgentApiKeySaveRequest) =>
    serial(() => mutate(store, cloud, async () => cloud.push(await store.save(request))))
  )
  ipcMain.handle('agentApiKeys:remove', (_event, raw: unknown) =>
    serial(() =>
      mutate(store, cloud, async () => {
        const request = removeRequestOf(raw)
        const key = request ? (await store.list()).find((entry) => entry.id === request.id) : null
        if (!request || !key) {
          return
        }
        const account = await cloud.beforeRemove(key, request.fromAccount)
        if (!account.ok) {
          return { kind: 'failed', error: account.error }
        }
        await store.remove(key.id)
        await account.forget()
        return account.removedFromAccount ? { kind: 'removed' } : { kind: 'skipped' }
      })
    )
  )
  // The key desktopKeyValueForCloud picks: this agent's every-host key for the variable.
  setAgentApiKeyCloudRecorder((agent, envName) =>
    serial(async () => {
      const key = selectAgentApiKeys(await store.list(), agent, ANY_CLOUD_HOST).find(
        (entry) => entry.envName === envName
      )
      if (key) {
        await cloud.record(key)
      }
    })
  )
  registerAgentApiKeyCloudHandlers({ store, cloud, serial })
  retry?.stop()
  retry = createAgentApiKeyCloudRetry({
    cloud,
    serial,
    notify: () => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('agentApiKeys:changed')
        }
      }
    }
  })
  // At start (a save from last session may be waiting) and after sleep, when the network returns.
  retry.kick({ soon: true })
  if (!wakeHooked) {
    wakeHooked = true
    powerMonitor.on('resume', () => retry?.kick({ soon: true }))
    powerMonitor.on('unlock-screen', () => retry?.kick({ soon: true }))
  }
  return store
}
