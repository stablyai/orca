import { BrowserWindow, ipcMain } from 'electron'
import {
  CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL,
  CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL,
  type CloudAgentConfigSyncPreferences
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { createCloudAgentConfigSync, type CloudAgentConfigSync } from './cloud-agent-config-sync'

let instance: CloudAgentConfigSync | null = null

function send(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}

function environmentIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function preferencesOf(value: unknown): Partial<CloudAgentConfigSyncPreferences> {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw.autoSync === 'boolean' ? { autoSync: raw.autoSync } : {}),
    ...(typeof raw.shareAcrossAgents === 'boolean'
      ? { shareAcrossAgents: raw.shareAcrossAgents }
      : {})
  }
}

/** Orca Cloud builds only; other builds answer null so the renderer hides the pane. */
export function installCloudAgentConfigSync(userDataPath: string): CloudAgentConfigSync {
  instance ??= createCloudAgentConfigSync({
    userDataPath,
    broadcast: (status) => send(CLOUD_AGENT_CONFIG_SYNC_CHANGED_CHANNEL, status),
    broadcastPreferences: (preferences) =>
      send(CLOUD_AGENT_CONFIG_SYNC_PREFERENCES_CHANNEL, preferences)
  })
  return instance
}

const CHANNELS = [
  'cloudAgentConfigSync:getStatus',
  'cloudAgentConfigSync:syncNow',
  'cloudAgentConfigSync:getPreferences',
  'cloudAgentConfigSync:setPreferences',
  'cloudAgentConfigSync:setItemIncluded'
] as const

export function registerCloudAgentConfigSyncHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('cloudAgentConfigSync:getStatus', (_event, value: unknown) => {
    const environmentId = environmentIdOf(value)
    return environmentId && instance ? instance.getStatus(environmentId) : null
  })
  ipcMain.handle('cloudAgentConfigSync:syncNow', (_event, value: unknown) => {
    const environmentId = environmentIdOf(value)
    return environmentId && instance ? instance.sync(environmentId, 'manual') : null
  })
  ipcMain.handle('cloudAgentConfigSync:getPreferences', async () => {
    if (!instance) {
      return null
    }
    await instance.ready
    return instance.getPreferences()
  })
  ipcMain.handle('cloudAgentConfigSync:setPreferences', (_event, value: unknown) =>
    instance ? instance.setPreferences(preferencesOf(value)) : null
  )
  ipcMain.handle(
    'cloudAgentConfigSync:setItemIncluded',
    (_event, key: unknown, included: unknown) =>
      instance && typeof key === 'string' && key.length <= 300 && typeof included === 'boolean'
        ? instance.setItemIncluded(key, included)
        : null
  )
}
