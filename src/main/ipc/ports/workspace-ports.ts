import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from '../../ports/advertised-url-watcher'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortPageProbeRequest,
  WorkspacePortPageProbeResult,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../../../shared/workspace/ports/workspace-ports'
import {
  getStoreWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../../ports/workspace-port-ownership'
import { probeWorkspacePortPage } from '../../ports/workspace-port-page-probe'
import { WorkspacePortScanParams } from '../../../shared/rpc-contract/workspaces/workspace-ports-params'

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
  ipcMain.removeHandler('workspacePorts:probePage')
  ipcMain.handle(
    'workspacePorts:scan',
    (_event, rawArgs?: unknown): Promise<WorkspacePortScanResult> => {
      const args = parseScanRequest(rawArgs)
      const worktrees = getStoreWorkspacePortProbes(store, args?.repoId)
      const key = JSON.stringify([
        args?.freshOwners === true,
        worktrees
          .map((worktree) => [worktree.id, worktree.repoId, worktree.displayName, worktree.path])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      ])
      const existing = inFlightScans.get(key)
      if (existing) {
        return existing
      }

      const promise = scanWorkspacePortProbes(worktrees, {
        freshOwners: args?.freshOwners
      }).finally(() => {
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

  ipcMain.handle(
    'workspacePorts:probePage',
    async (_event, rawArgs?: unknown): Promise<WorkspacePortPageProbeResult> => {
      const args = parseProbePageRequest(rawArgs)
      return args ? probeWorkspacePortPage(args) : { kind: 'not-page' }
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

function parseScanRequest(value: unknown): WorkspacePortScanRequest | undefined {
  const parsed = WorkspacePortScanParams.safeParse(value)
  if (!parsed.success) {
    return undefined
  }
  const { repoId, freshOwners } = parsed.data
  // Only Linux caches listener owners; elsewhere a fresh request must keep sharing the running scan.
  const fresh = freshOwners && process.platform === 'linux'
  return { ...(repoId ? { repoId } : {}), ...(fresh ? { freshOwners: true } : {}) }
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

function parseProbePageRequest(value: unknown): WorkspacePortPageProbeRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const host = 'host' in value ? value.host : undefined
  const port = 'port' in value ? value.port : undefined
  if (typeof host !== 'string' || typeof port !== 'number' || !Number.isSafeInteger(port)) {
    return null
  }
  const protocol = 'protocol' in value && value.protocol === 'https' ? 'https' : 'http'
  return { host, port, protocol }
}
