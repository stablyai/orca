import { ipcRenderer, webUtils } from 'electron'
import { createBrowserClientPageRendererRequests } from './browser-client-page-renderer-requests'
import { createBrowserFindSubscriptions } from './browser-find-subscriptions'
import { registerRendererRestartIpcRelays } from './renderer-restart-wiring'
import { createUpdaterQuitAbortRelay } from '../shared/renderer-restart-preparation'
import { ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT } from '../shared/updater-renderer-events'
import {
  ORCA_INTERNAL_FILE_DRAG_TYPE,
  createNativeFileDropPayload,
  createRejectedNativeFileDropPayload,
  hasNativeFileDragTypes,
  NATIVE_FILE_DROP_MAX_PATHS,
  resolveNativeFileDropPath,
  type NativeDropResolution,
  type NativeFileDropPayload,
  type NativeFileDropPathEntry
} from '../shared/native-file-drop'

/** Joins the synchronous unload checkpoint with its durable renderer write. */
export async function awaitBeforeUnloadCheckpoint(): Promise<void> {
  const result = (await ipcRenderer.invoke('app:await-before-unload-checkpoint')) as {
    ok?: unknown
  }
  if (result?.ok !== true) {
    throw new Error('Failed to persist renderer state before unload.')
  }
}

export const startupDiagnosticsEnabled = process.env.ORCA_STARTUP_DIAGNOSTICS === '1'

export function getLinuxDisplayServer(): 'wayland' | 'x11' | null {
  if (process.platform !== 'linux') {
    return null
  }
  if (
    process.env.WAYLAND_DISPLAY ||
    process.env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' ||
    process.env.ELECTRON_OZONE_PLATFORM_HINT?.toLowerCase() === 'wayland'
  ) {
    return 'wayland'
  }
  return process.env.DISPLAY ? 'x11' : null
}

type NativeFileDropCallback = (data: NativeFileDropPayload) => void
const nativeFileDropCallbacks: NativeFileDropCallback[] = []
let nativeFileDropListenerRegistered = false

const onNativeFileDrop = (_event: Electron.IpcRendererEvent, data: NativeFileDropPayload): void => {
  for (const callback of Array.from(nativeFileDropCallbacks)) {
    callback(data)
  }
}

export function subscribeNativeFileDrop(callback: NativeFileDropCallback): () => void {
  nativeFileDropCallbacks.push(callback)
  if (!nativeFileDropListenerRegistered) {
    ipcRenderer.on('terminal:file-drop', onNativeFileDrop)
    nativeFileDropListenerRegistered = true
  }
  return () => {
    const callbackIndex = nativeFileDropCallbacks.indexOf(callback)
    if (callbackIndex !== -1) {
      nativeFileDropCallbacks.splice(callbackIndex, 1)
    }
    if (nativeFileDropCallbacks.length === 0 && nativeFileDropListenerRegistered) {
      ipcRenderer.removeListener('terminal:file-drop', onNativeFileDrop)
      nativeFileDropListenerRegistered = false
    }
  }
}

function resolveNativeFileDrop(event: DragEvent): NativeDropResolution | null {
  const pathEntries: NativeFileDropPathEntry[] = []
  for (const entry of event.composedPath()) {
    if (entry instanceof HTMLElement) {
      pathEntries.push({
        nativeFileDropTarget: entry.dataset.nativeFileDropTarget,
        nativeFileDropDir: entry.dataset.nativeFileDropDir,
        terminalTabId: entry.dataset.terminalTabId,
        terminalPaneLeafId: entry.dataset.terminalPaneLeafId ?? entry.dataset.leafId
      })
    }
  }
  return resolveNativeFileDropPath(pathEntries)
}

/** Installs the one preload-side listener that converts native File objects to paths. */
export function installNativeFileDropHandlers(): void {
  document.addEventListener(
    'dragover',
    (event) => {
      if (event.dataTransfer && !hasNativeFileDragTypes(event.dataTransfer.types)) {
        return
      }
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    },
    true
  )
  document.addEventListener(
    'drop',
    (event) => {
      if (event.dataTransfer?.types.includes(ORCA_INTERNAL_FILE_DRAG_TYPE)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) {
        return
      }
      const resolution = resolveNativeFileDrop(event)
      if (files.length > NATIVE_FILE_DROP_MAX_PATHS) {
        ipcRenderer.send(
          'terminal:file-dropped-from-preload',
          createRejectedNativeFileDropPayload({
            byteLength: 0,
            pathCount: files.length,
            reason: 'too-many-paths',
            status: 'rejected'
          })
        )
        return
      }
      const paths: string[] = []
      for (let index = 0; index < files.length; index += 1) {
        const filePath = webUtils.getPathForFile(files[index])
        if (filePath) {
          paths.push(filePath)
        }
      }
      if (paths.length === 0 || resolution?.target === 'rejected') {
        return
      }
      const payload = createNativeFileDropPayload(resolution, paths)
      if (payload) {
        ipcRenderer.send('terminal:file-dropped-from-preload', payload)
      }
    },
    true
  )
}

export const browserFindSubscriptions = createBrowserFindSubscriptions()
export const browserClientPageRendererRequests = createBrowserClientPageRendererRequests({
  ipc: ipcRenderer,
  isTopFrame: () => window.top === window
})

/** Registers browser find forwarding once for this preload context. */
export function installBrowserFindListener(): void {
  ipcRenderer.on('ui:findInBrowserPage', (_event, source: unknown) => {
    browserFindSubscriptions.dispatch(source)
  })
}

export const updaterQuitAbortRelay = createUpdaterQuitAbortRelay(
  window,
  ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT
)

registerRendererRestartIpcRelays(ipcRenderer, window, updaterQuitAbortRelay)
