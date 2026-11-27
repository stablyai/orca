import type { BrowserWindow } from 'electron'
import type { MacWindowCloseBehavior } from '../../../shared/app-lifecycle/windows/macos-window-close-behavior'
import { hasSystemTray } from '../../tray/system-tray'
import { safelyRevealWindow } from '../activation/focus-existing-window'
import { deferAppKitSceneMutation } from '../desktop-integration/appkit-scene-mutation'
import { macWindowsHiddenToMenuBar } from './macos-menu-bar-hidden-window'

const FULL_SCREEN_EXIT_TIMEOUT_MS = 3_000

export function installMacWindowCloseBehavior(
  window: BrowserWindow,
  options: {
    getBehavior: () => MacWindowCloseBehavior | undefined
    isQuitting: () => boolean
    isRendererGone: () => boolean
    quit?: () => void
  }
): { handleClose: () => boolean; cancelPendingHide: () => void } {
  let pendingHide: AbortController | null = null
  let quitScheduled = false
  const cancelPendingHide = (): void => {
    pendingHide?.abort()
    pendingHide = null
  }
  window.on('show', () => macWindowsHiddenToMenuBar.delete(window))
  window.once('closed', cancelPendingHide)

  const canFinishClose = (): boolean =>
    !window.isDestroyed() && !options.isQuitting() && !options.isRendererGone()

  const hide = (signal: AbortSignal): void => {
    if (signal.aborted) {
      return
    }
    pendingHide = null
    if (
      canFinishClose() &&
      !window.isFullScreen() &&
      options.getBehavior() === 'hide-to-menu-bar' &&
      hasSystemTray()
    ) {
      macWindowsHiddenToMenuBar.add(window)
      window.hide()
    }
  }

  const handleClose = (): boolean => {
    const behavior = options.getBehavior()
    const quit = options.quit
    if (behavior === 'quit-app' && quit) {
      cancelPendingHide()
      if (!quitScheduled) {
        quitScheduled = true
        deferAppKitSceneMutation(() => {
          quitScheduled = false
          if (!window.isDestroyed() && !options.isQuitting()) {
            quit()
          }
        })
      }
      return true
    }
    if (behavior !== 'hide-to-menu-bar' || !canFinishClose() || !hasSystemTray()) {
      return false
    }
    if (pendingHide) {
      return true
    }
    pendingHide = new AbortController()
    const { signal } = pendingHide
    deferAppKitSceneMutation(() => {
      if (signal.aborted || !canFinishClose() || !window.isFullScreen()) {
        hide(signal)
        return
      }
      const cleanup = (): void => {
        clearTimeout(timeout)
        window.removeListener('leave-full-screen', onExit)
      }
      const onExit = (): void => {
        cleanup()
        deferAppKitSceneMutation(() => hide(signal))
      }
      // An interrupted AppKit transition may never emit leave-full-screen.
      const timeout = setTimeout(onExit, FULL_SCREEN_EXIT_TIMEOUT_MS)
      timeout.unref()
      signal.addEventListener('abort', cleanup, { once: true })
      window.once('leave-full-screen', onExit)
      window.setFullScreen(false)
    })
    return true
  }
  return { handleClose, cancelPendingHide }
}

export function confirmCloseAfterMenuBarRestore(window: BrowserWindow, confirm: () => void): void {
  if (!macWindowsHiddenToMenuBar.has(window)) {
    confirm()
    return
  }
  deferAppKitSceneMutation(() => {
    if (!window.isDestroyed()) {
      // The quit confirmation can open a save prompt in the renderer.
      safelyRevealWindow(window)
      confirm()
    }
  })
}
