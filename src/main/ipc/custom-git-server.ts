import { ipcMain } from 'electron'
import type {
  CustomGitServerApiFlavor,
  CustomGitServerDraft
} from '../../shared/custom-git-server'
import {
  DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR,
  isCustomGitServerApiFlavor
} from '../../shared/custom-git-server'
import {
  getCustomGitServerStatuses,
  listCustomGitServers,
  removeCustomGitServer,
  saveCustomGitServer,
  testCustomGitServerConnection
} from '../custom-git-server/store'
import { _resetCustomGitServerRepoRefCache } from '../custom-git-server/repository-ref'
import { _resetPreflightCache } from './preflight'

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function apiFlavor(value: unknown): CustomGitServerApiFlavor {
  return isCustomGitServerApiFlavor(value) ? value : DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR
}

function normalizeDraft(input: unknown): CustomGitServerDraft & { id?: string; token?: string } {
  const record = (input ?? {}) as Record<string, unknown>
  return {
    ...(typeof record.id === 'string' && record.id ? { id: record.id } : {}),
    name: str(record.name),
    host: str(record.host),
    apiBaseUrl: str(record.apiBaseUrl),
    apiFlavor: apiFlavor(record.apiFlavor),
    ...(typeof record.token === 'string' ? { token: record.token } : {})
  }
}

/** Register IPC handlers for listing, saving, removing, and testing custom git servers. */
export function registerCustomGitServerHandlers(): void {
  ipcMain.handle('customGitServer:list', async () => listCustomGitServers())

  ipcMain.handle('customGitServer:status', async () => getCustomGitServerStatuses())

  ipcMain.handle('customGitServer:save', async (_event, input: unknown) => {
    const draft = normalizeDraft(input)
    if (!draft.name.trim() || !draft.host.trim() || !draft.apiBaseUrl.trim()) {
      throw new Error('Name, host, and API base URL are required.')
    }
    const server = saveCustomGitServer(draft)
    // A changed server list can flip which provider a repo resolves to.
    _resetCustomGitServerRepoRefCache()
    _resetPreflightCache()
    return server
  })

  ipcMain.handle('customGitServer:remove', async (_event, args: { id?: unknown }) => {
    const id = str(args?.id)
    if (!id) {
      return
    }
    removeCustomGitServer(id)
    _resetCustomGitServerRepoRefCache()
    _resetPreflightCache()
  })

  ipcMain.handle('customGitServer:test', async (_event, input: unknown) => {
    const draft = normalizeDraft(input)
    return testCustomGitServerConnection({ ...draft, token: str(draft.token) })
  })
}
