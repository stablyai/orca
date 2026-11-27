import { ipcMain } from 'electron'
import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { onDocPreviewGrantRevoked } from '../../browser/document-preview/doc-preview-grant-registry'
import {
  disposeGrabModeStateForPage,
  resetGrabModeState
} from '../../browser/element-grab/browser-grab-mode-admission'

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

// Runtime grab commands write the shared grab-mode state without ever loading browser-grab-ipc,
// so page teardown, reset, and grant-revocation cleanup must not wait for the first grab invoke.
export function disposeLazyGrabModeStateForPage(browserPageId: string): void {
  disposeGrabModeStateForPage(browserPageId)
}

export function resetLazyGrabModeState(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = null
  resetGrabModeState()
}

let disposePreviewGrantSubscription: (() => void) | null = null

function subscribeToPreviewGrantRevocation(): void {
  disposePreviewGrantSubscription?.()
  disposePreviewGrantSubscription = onDocPreviewGrantRevoked((grant) => {
    browserManager.cancelGrabOp(grant.browserPageId, 'evicted')
    disposeGrabModeStateForPage(grant.browserPageId)
  })
}

export function registerLazyBrowserGrabHandlers(): void {
  subscribeToPreviewGrantRevocation()
  for (const channel of BROWSER_GRAB_IPC_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  registerLazyIpcHandleGroup(BROWSER_GRAB_IPC_CHANNELS, async (ipc) => {
    const { registerBrowserGrabHandlers } = await import('./browser-grab-ipc')
    registerBrowserGrabHandlers(ipc)
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
