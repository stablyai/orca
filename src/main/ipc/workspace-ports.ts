import path from 'node:path'
import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from '../ports/advertised-url-watcher'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import {
  getStoreWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'
import {
  enrichScanWithPreviewUrls,
  getActivePreviewProxyConfig,
  type PreviewWorktreeDescriptor
} from '../ports/worktree-preview-routes'

type WorkspacePortHandlersOptions = {
  advertisedUrlEvents?: Pick<AdvertisedUrlWatcher, 'onDidChange'>
  getWindows?: () => BrowserWindow[]
}

let unsubscribeAdvertisedUrlChanges: (() => void) | null = null

export function registerWorkspacePortHandlers(
  store: Store,
  options: WorkspacePortHandlersOptions = {}
): void {
  const inFlightScans = new Map<string, Promise<WorkspacePortScanResult>>()
  const advertisedUrlEvents = options.advertisedUrlEvents ?? advertisedUrlWatcher
  const getWindows = options.getWindows ?? (() => BrowserWindow.getAllWindows())

  unsubscribeAdvertisedUrlChanges?.()
  unsubscribeAdvertisedUrlChanges = advertisedUrlEvents.onDidChange((event) => {
    const localWorktrees = getStoreWorkspacePortProbes(store)
    if (!localWorktrees.some((worktree) => worktree.id === event.worktreeId)) {
      return
    }
    broadcastWorkspacePortAdvertisedUrlChanged(getWindows, event)
  })

  ipcMain.removeHandler('workspacePorts:scan')
  ipcMain.removeHandler('workspacePorts:kill')
  ipcMain.handle(
    'workspacePorts:scan',
    (_event, rawArgs?: unknown): Promise<WorkspacePortScanResult> => {
      const args = parseScanRequest(rawArgs)
      const worktrees = getStoreWorkspacePortProbes(store, args?.repoId)
      const key = JSON.stringify(
        worktrees
          .map((worktree) => [worktree.id, worktree.repoId, worktree.displayName, worktree.path])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      )
      const existing = inFlightScans.get(key)
      if (existing) {
        return existing
      }

      const promise = scanWorkspacePortProbes(worktrees)
        .then((scan) => {
          // Why: when the settings-driven preview proxy is live, the local
          // panel shows the same shareable URLs remote clients see.
          const previewConfig = getActivePreviewProxyConfig()
          return previewConfig
            ? enrichScanWithPreviewUrls(scan, storePreviewDescriptors(store), previewConfig)
            : scan
        })
        .finally(() => {
          if (inFlightScans.get(key) === promise) {
            inFlightScans.delete(key)
          }
        })
      inFlightScans.set(key, promise)
      return promise
    }
  )

  ipcMain.handle(
    'workspacePorts:kill',
    async (_event, rawArgs?: unknown): Promise<WorkspacePortKillResult> => {
      const args = parseKillRequest(rawArgs)
      if (!args) {
        return { ok: false, reason: 'Invalid process or port.' }
      }
      const worktrees = getStoreWorkspacePortProbes(store, args.repoId)
      return killWorkspacePort(worktrees, args)
    }
  )
}

function broadcastWorkspacePortAdvertisedUrlChanged(
  getWindows: () => BrowserWindow[],
  event: WorkspacePortAdvertisedUrlChangedEvent
): void {
  for (const window of getWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    const webContents = window.webContents
    if (webContents.isDestroyed()) {
      continue
    }
    webContents.send('workspacePorts:advertised-url-changed', event)
  }
}

// Why: preview labels need the project name; unfiltered probes so labels stay
// stable regardless of which repo the scan request was scoped to.
function storePreviewDescriptors(store: Store): PreviewWorktreeDescriptor[] {
  const reposById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
  return getStoreWorkspacePortProbes(store).map((probe) => {
    const repo = reposById.get(probe.repoId)
    return {
      worktreeId: probe.id,
      repoId: probe.repoId,
      // Why: an empty project name slugifies to the generic "workspace", so
      // every unnamed repo's primary worktree would answer to the same label.
      projectName: repo?.displayName || (repo ? path.basename(repo.path) : probe.displayName),
      worktreeName: probe.displayName,
      worktreePath: probe.path
    }
  })
}

function parseScanRequest(value: unknown): WorkspacePortScanRequest | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const repoId = (value as { repoId?: unknown }).repoId
  return typeof repoId === 'string' && repoId.length > 0 ? { repoId } : undefined
}

function parseKillRequest(value: unknown): WorkspacePortKillRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const args = value as { repoId?: unknown; pid?: unknown; port?: unknown }
  if (!Number.isSafeInteger(args.pid) || !Number.isSafeInteger(args.port)) {
    return null
  }
  const pid = args.pid as number
  const port = args.port as number
  return {
    ...(typeof args.repoId === 'string' && args.repoId.length > 0 ? { repoId: args.repoId } : {}),
    pid,
    port
  }
}
