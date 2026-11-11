// Wires cloud → this computer sync into main: the orcad transport (on its own queue lane, so sync
// never competes with the window's reads), lifecycle signals, and the window's IPC.
import { mkdir } from 'node:fs/promises'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { onEphemeralVmRuntimesChanged } from '../../shared/ephemeral-vm-runtime-store-events'
import { listEphemeralVmRuntimes } from '../../shared/ephemeral-vm-runtime-store'
import { ORCA_CLOUD_SYNC_CHANNELS as CH } from '../../shared/cloud-sync/cloud-sync-contract'
import {
  callRuntimeEnvironment,
  subscribeRuntimeEnvironment
} from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { isCloudWorkspaceArchivedOnControlPlane } from '../hosted-sandbox/hosted-workspace-runtime'
import { subscribeSystemPowerLifecycle } from '../power/system-power-lifecycle'
import type { SyncCall } from './cloud-sync-remote'
import type { WatchSubscribe } from './cloud-sync-session'
import { createCloudSyncService, type CloudSyncService } from './cloud-sync-service'
import { createCloudSyncStore } from './cloud-sync-store'

const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** Picks up runtime records that changed without an event, and the archived-elsewhere check. */
const BEAT_MS = 60_000

function callFor(userDataPath: string, environmentId: string): SyncCall {
  return async <T>(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<T> => {
    const response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      method,
      params,
      options?.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      undefined,
      undefined,
      { lane: 'download', ...(options?.signal ? { signal: options.signal } : {}) }
    )
    if (response.ok === true) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each caller names the result type of the orcad method it calls, and cloud-sync-remote validates every reply with zod before use.
      return response.result as T
    }
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
}

function watchFor(userDataPath: string, environmentId: string): WatchSubscribe {
  return async (selector, handlers) => {
    let closed = false
    const close = (): void => {
      if (!closed) {
        closed = true
        handlers.onClose()
      }
    }
    const subscription = await subscribeRuntimeEnvironment(
      userDataPath,
      environmentId,
      'files.watch',
      { worktree: selector, batchCadence: 'interval' },
      undefined,
      {
        onEvent: (payload) => {
          if (payload.type === 'response') {
            if (payload.response.ok === true) {
              handlers.onEvent(payload.response.result)
            } else {
              close()
            }
          } else if (payload.type === 'error' || payload.type === 'close') {
            close()
          }
        },
        onClose: close
      }
    )
    return {
      close: () => {
        // Our own close is not a drop: no retry.
        closed = true
        subscription.close()
      }
    }
  }
}

let service: CloudSyncService | null = null

/** The running sync service (null before install or when Orca Cloud is off). */
export function getCloudSyncService(): CloudSyncService | null {
  return service
}

/** Installs once per app run; stops (sessions, timers, IPC) when the app quits. */
export function installCloudSync(
  userDataPath: string,
  windows: () => readonly BrowserWindow[] = () => BrowserWindow.getAllWindows()
): () => void {
  const deps = { userDataPath, windows }
  const store = createCloudSyncStore(deps.userDataPath)
  const sync = createCloudSyncService({
    store,
    listRuntimes: () => listEphemeralVmRuntimes(deps.userDataPath),
    callFor: (environmentId) => callFor(deps.userDataPath, environmentId),
    watchFor: (environmentId) => watchFor(deps.userDataPath, environmentId),
    isArchived: (workspaceId) => isCloudWorkspaceArchivedOnControlPlane(workspaceId),
    broadcast: (view) => {
      for (const window of deps.windows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(CH.changed, view)
        }
      }
    },
    openPath: async (path) => {
      // The folder line shows this path; make sure there is a folder to open (empty .context).
      await mkdir(path, { recursive: true })
      return (await shell.openPath(path)) === ''
    }
  })
  service = sync

  for (const channel of [CH.getState, CH.setChoice, CH.openFolder, CH.retry, CH.removalPreview]) {
    ipcMain.removeHandler(channel)
  }
  ipcMain.handle(CH.getState, (_event, workspaceId: unknown) =>
    typeof workspaceId === 'string' ? sync.getState(workspaceId) : null
  )
  ipcMain.handle(
    CH.setChoice,
    (_event, args: { workspaceId?: unknown; context?: unknown; mirror?: unknown }) => {
      if (typeof args?.workspaceId !== 'string') {
        return null
      }
      return sync.setChoice(args.workspaceId, {
        ...(typeof args.context === 'boolean' ? { context: args.context } : {}),
        ...(typeof args.mirror === 'boolean' ? { mirror: args.mirror } : {})
      })
    }
  )
  ipcMain.handle(CH.openFolder, (_event, workspaceId: unknown) =>
    typeof workspaceId === 'string' ? sync.openFolder(workspaceId) : { ok: false }
  )
  ipcMain.handle(CH.retry, (_event, workspaceId: unknown) =>
    typeof workspaceId === 'string' ? sync.retry(workspaceId) : undefined
  )
  ipcMain.handle(CH.removalPreview, (_event, workspaceId: unknown) =>
    typeof workspaceId === 'string'
      ? sync.removalPreview(workspaceId)
      : { hasLocalCopy: false, editedHere: 0 }
  )

  const offRuntimes = onEphemeralVmRuntimesChanged(() => void sync.reconcile())
  let sawSuspend = false
  const offPower = subscribeSystemPowerLifecycle({
    onSuspend: () => {
      sawSuspend = true
    },
    // Fires once on subscribe with the current (awake) state; only a real wake resyncs.
    onResume: () => {
      if (sawSuspend) {
        sawSuspend = false
        sync.noteSystemResumed()
      }
    }
  })
  // One reconcile per beat, scheduled after the last one finished (never stacked).
  let beat: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const scheduleBeat = (): void => {
    if (stopped) {
      return
    }
    beat = setTimeout(() => void sync.reconcile().finally(scheduleBeat), BEAT_MS)
    beat.unref?.()
  }
  void sync.reconcile().finally(scheduleBeat)

  const dispose = (): void => {
    stopped = true
    if (beat) {
      clearTimeout(beat)
    }
    offRuntimes()
    offPower()
    for (const channel of [CH.getState, CH.setChoice, CH.openFolder, CH.retry, CH.removalPreview]) {
      ipcMain.removeHandler(channel)
    }
    service = null
    void sync.dispose()
  }
  app.once('will-quit', dispose)
  return dispose
}
