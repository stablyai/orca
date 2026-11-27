import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import type * as BrowserGrabIpc from './browser-grab-ipc'

const BROWSER_GRAB_IPC_CHANNELS = [
  'browser:setGrabMode',
  'browser:captureCleanPage',
  'browser:awaitGrabSelection',
  'browser:setGrabLabelAvoidArea',
  'browser:grabPickedElementPresent',
  'browser:cancelGrab',
  'browser:captureSelectionScreenshot',
  'browser:extractHoverPayload'
] as const

const BROWSER_DICTATION_IPC_CHANNELS = ['browser:insertDictationText'] as const

let loadedGrabModule: typeof BrowserGrabIpc | null = null

export function disposeLazyGrabModeStateForPage(browserPageId: string): void {
  loadedGrabModule?.disposeGrabModeStateForPage(browserPageId)
}

export function resetLazyGrabModeState(): void {
  loadedGrabModule?.resetGrabModeState()
}

export function registerLazyBrowserGrabHandlers(): void {
  for (const channel of BROWSER_GRAB_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_GRAB_IPC_CHANNELS, async (ipc) => {
    const mod = await import('./browser-grab-ipc')
    loadedGrabModule = mod
    mod.registerBrowserGrabHandlers(ipc)
  })
}

export function registerLazyBrowserDictationHandlers(): void {
  for (const channel of BROWSER_DICTATION_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_DICTATION_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserDictationHandlers } = await import('./browser-dictation-ipc')
    registerBrowserDictationHandlers(ipc)
  })
}
