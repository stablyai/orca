import { BrowserWindow, ipcMain } from 'electron'
import { isMcpRecord } from '../../../shared/agent-mcp-sync/mcp-server-portability'
import type { McpSyncStatus } from '../../../shared/agent-mcp-sync/mcp-sync-contract'
import { CLOUD_MCP_SYNC_CHANGED_CHANNEL } from '../../../shared/agent-mcp-sync/mcp-sync-preferences'
import {
  createCloudMcpSync,
  type CloudMcpSync,
  type CloudMcpSyncPreferences
} from './cloud-mcp-sync'
import { createCloudMcpEgress } from './cloud-mcp-egress'
import type { HostedSandboxControlPlaneClientOptions } from '../../hosted-sandbox/hosted-sandbox-request'

let instance: CloudMcpSync | null = null

function environmentIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null
}

function preferencesOf(value: unknown): Partial<CloudMcpSyncPreferences> {
  if (!isMcpRecord(value)) {
    return {}
  }
  const raw = value
  return {
    ...(typeof raw.autoSync === 'boolean' ? { autoSync: raw.autoSync } : {}),
    ...(Array.isArray(raw.excluded)
      ? {
          excluded: raw.excluded
            .filter((key): key is string => typeof key === 'string' && key.length <= 200)
            .slice(0, 512)
        }
      : {})
  }
}

/** Orca Cloud builds only; other builds answer null so the renderer hides the affordance. */
export function installCloudMcpSync(
  userDataPath: string,
  controlPlane: HostedSandboxControlPlaneClientOptions
): CloudMcpSync {
  instance ??= createCloudMcpSync({
    userDataPath,
    egress: createCloudMcpEgress({ userDataPath, controlPlane }),
    broadcast: (status: McpSyncStatus) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(CLOUD_MCP_SYNC_CHANGED_CHANNEL, status)
        }
      }
    }
  })
  return instance
}

const CHANNELS = [
  'cloudMcpSync:getStatus',
  'cloudMcpSync:syncNow',
  'cloudMcpSync:setPreferences',
  'cloudMcpSync:getPreferences',
  'cloudMcpSync:setServerIncluded'
] as const

export function registerCloudMcpSyncHandlers(): void {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle('cloudMcpSync:getStatus', (_event, value: unknown) => {
    const environmentId = environmentIdOf(value)
    return environmentId && instance ? instance.getStatus(environmentId) : null
  })
  ipcMain.handle('cloudMcpSync:syncNow', (_event, value: unknown) => {
    const environmentId = environmentIdOf(value)
    return environmentId && instance ? instance.sync(environmentId, 'manual') : null
  })
  ipcMain.handle('cloudMcpSync:setPreferences', (_event, value: unknown) =>
    instance ? instance.setPreferences(preferencesOf(value)) : null
  )
  ipcMain.handle('cloudMcpSync:getPreferences', () => instance?.getPreferences() ?? null)
  ipcMain.handle('cloudMcpSync:setServerIncluded', (_event, key: unknown, included: unknown) =>
    instance && typeof key === 'string' && key.length <= 200 && typeof included === 'boolean'
      ? instance.setServerIncluded(key, included)
      : null
  )
}
