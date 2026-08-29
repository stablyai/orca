import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import type {
  GitHubAccountStatus,
  GitHubCloneRepoArgs,
  GitHubCloneRepoResult,
  GitHubConnectTokenResult,
  GitHubDeleteClonedRepoFilesResult,
  GitHubDeviceFlowPollResult,
  GitHubDeviceFlowStartResult,
  GitHubRepoListResult
} from '../../shared/github-account'
import {
  connectGitHubWithToken,
  disconnectGitHub,
  getGitHubAccountStatus,
  listGitHubAccountRepos,
  pollGitHubAccountDeviceFlow,
  startGitHubAccountDeviceFlow
} from '../github-auth/connection'
import { cloneGitHubAccountRepo } from '../github-auth/clone-repo'
import { deleteGitHubClonedRepoFiles } from '../github-auth/delete-cloned-repo-files'
import { _resetPreflightCache } from './preflight'

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function normalizeCloneArgs(value: unknown): GitHubCloneRepoArgs | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  const fullName = asString(raw.fullName)
  const cloneUrl = asString(raw.cloneUrl)
  const destination = asString(raw.destination)
  if (!fullName || !cloneUrl || !destination) {
    return null
  }
  return { fullName, cloneUrl, isPrivate: raw.isPrivate === true, destination }
}

// Auth-only handlers; registered once from register-core-handlers.
export function registerGitHubAuthHandlers(): void {
  ipcMain.handle('githubAuth:status', async (): Promise<GitHubAccountStatus> => {
    return getGitHubAccountStatus()
  })

  ipcMain.handle(
    'githubAuth:connectWithToken',
    async (_event, args: unknown): Promise<GitHubConnectTokenResult> => {
      const token = asString((args as Record<string, unknown> | null)?.token)
      if (!token) {
        return { ok: false, error: 'Enter a personal access token.' }
      }
      const result = await connectGitHubWithToken(token, 'pat')
      if (result.ok) {
        // Preflight caches source-control status per session; reset so the card
        // reflects the new connection without a relaunch.
        _resetPreflightCache()
      }
      return result
    }
  )

  ipcMain.handle('githubAuth:startDeviceFlow', async (): Promise<GitHubDeviceFlowStartResult> => {
    return startGitHubAccountDeviceFlow()
  })

  ipcMain.handle(
    'githubAuth:pollDeviceFlow',
    async (_event, args: unknown): Promise<GitHubDeviceFlowPollResult> => {
      const deviceCode = asString((args as Record<string, unknown> | null)?.deviceCode)
      if (!deviceCode) {
        return { status: 'error', error: 'The sign-in session is no longer valid. Start over.' }
      }
      const result = await pollGitHubAccountDeviceFlow(deviceCode)
      if (result.status === 'connected') {
        _resetPreflightCache()
      }
      return result
    }
  )

  ipcMain.handle('githubAuth:disconnect', async (): Promise<void> => {
    disconnectGitHub()
    _resetPreflightCache()
  })

  ipcMain.handle('githubAuth:listRepos', async (): Promise<GitHubRepoListResult> => {
    return listGitHubAccountRepos()
  })
}

// Clone needs the live main window for progress events and the repo store, so
// it registers alongside the other repo handlers (re-registered on macOS
// re-activation — callers must removeHandler first, as registerRepoHandlers does).
export function registerGitHubAccountCloneHandlers(mainWindow: BrowserWindow, store: Store): void {
  ipcMain.handle(
    'githubAuth:cloneRepo',
    async (_event, args: unknown): Promise<GitHubCloneRepoResult> => {
      const input = normalizeCloneArgs(args)
      if (!input) {
        return { ok: false, error: 'Invalid GitHub clone request.' }
      }
      return cloneGitHubAccountRepo(mainWindow, store, input)
    }
  )

  ipcMain.handle(
    'githubAuth:deleteClonedRepoFiles',
    async (_event, args: unknown): Promise<GitHubDeleteClonedRepoFilesResult> => {
      const repoId = asString((args as Record<string, unknown> | null)?.repoId)
      if (!repoId) {
        return { ok: false, error: 'Invalid cleanup request.' }
      }
      return deleteGitHubClonedRepoFiles(store, repoId)
    }
  )
}
