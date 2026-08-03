import { BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { advertisedUrlWatcher, type AdvertisedUrlWatcher } from '../ports/advertised-url-watcher'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortProbe,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../../shared/workspace-ports'
import type {
  WorkspaceServiceScanResult,
  WorkspaceServiceStopRequest
} from '../../shared/workspace-services'
import { stopWorkspaceService } from '../ports/workspace-service-stop'
import {
  getStoreWorkspacePortProbes,
  killWorkspacePort,
  scanWorkspacePortProbes
} from '../ports/workspace-port-ownership'
import { scanWorkspaceServices } from '../ports/workspace-service-scan'

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

  const inFlightServiceScans = new Map<string, Promise<WorkspaceServiceScanResult>>()

  ipcMain.removeHandler('workspacePorts:scan')
  ipcMain.removeHandler('workspacePorts:scanServices')
  ipcMain.removeHandler('workspacePorts:kill')

  ipcMain.handle(
    'workspacePorts:scanServices',
    (_event, rawArgs?: unknown): Promise<WorkspaceServiceScanResult> => {
      const args = parseScanRequest(rawArgs)
      const worktrees = getStoreWorkspacePortProbes(store, args?.repoId)
      const key = workspaceProbeKey(worktrees)
      const existing = inFlightServiceScans.get(key)
      // Why: the panel, its refresh button and the poll can all fire at once;
      // one scan spawns three child processes, so coalescing matters here.
      if (existing) {
        return existing
      }

      const promise = scanWorkspaceServices(worktrees).finally(() => {
        if (inFlightServiceScans.get(key) === promise) {
          inFlightServiceScans.delete(key)
        }
      })
      inFlightServiceScans.set(key, promise)
      return promise
    }
  )
  ipcMain.handle(
    'workspacePorts:scan',
    (_event, rawArgs?: unknown): Promise<WorkspacePortScanResult> => {
      const args = parseScanRequest(rawArgs)
      const worktrees = getStoreWorkspacePortProbes(store, args?.repoId)
      const key = workspaceProbeKey(worktrees)
      const existing = inFlightScans.get(key)
      if (existing) {
        return existing
      }

      const promise = scanWorkspacePortProbes(worktrees).finally(() => {
        if (inFlightScans.get(key) === promise) {
          inFlightScans.delete(key)
        }
      })
      inFlightScans.set(key, promise)
      return promise
    }
  )

  ipcMain.removeHandler('workspacePorts:stopService')
  ipcMain.handle(
    'workspacePorts:stopService',
    async (_event, rawArgs?: unknown): Promise<WorkspacePortKillResult> => {
      const request = parseStopServiceRequest(rawArgs)
      if (!request) {
        return { ok: false, reason: 'Invalid service.' }
      }
      const repoId = request.kind === 'process' ? request.repoId : undefined
      return stopWorkspaceService(getStoreWorkspacePortProbes(store, repoId), request)
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

/** Identity of a probe set, so concurrent scans of the same workspaces coalesce. */
function workspaceProbeKey(worktrees: readonly WorkspacePortProbe[]): string {
  return JSON.stringify(
    worktrees
      .map((worktree) => [worktree.id, worktree.repoId, worktree.displayName, worktree.path])
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
  )
}

function parseScanRequest(value: unknown): WorkspacePortScanRequest | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const repoId = (value as { repoId?: unknown }).repoId
  return typeof repoId === 'string' && repoId.length > 0 ? { repoId } : undefined
}

function parseStopServiceRequest(value: unknown): WorkspaceServiceStopRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const args = value as {
    kind?: unknown
    containerId?: unknown
    repoId?: unknown
    pid?: unknown
    port?: unknown
    notifyAgent?: unknown
    serviceName?: unknown
    projectName?: unknown
  }
  if (args.kind === 'container') {
    return typeof args.containerId === 'string' && args.containerId.length > 0
      ? { kind: 'container', containerId: args.containerId }
      : null
  }
  if (args.kind !== 'process') {
    return null
  }
  if (!Number.isSafeInteger(args.pid) || !Number.isSafeInteger(args.port)) {
    return null
  }
  return {
    kind: 'process',
    ...(typeof args.repoId === 'string' && args.repoId.length > 0 ? { repoId: args.repoId } : {}),
    pid: args.pid as number,
    port: args.port as number,
    notifyAgent: args.notifyAgent === true,
    serviceName: typeof args.serviceName === 'string' ? args.serviceName : null,
    projectName: typeof args.projectName === 'string' ? args.projectName : null
  }
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
