import { app, ipcMain, webContents, type BaseWindow, type WebContents } from 'electron'
import type { Store } from '../persistence'
import { isAgentInjectingInput } from '../browser/agent-input-injection'
import { HoldQuitGesture } from './hold-quit-gesture'
import { watchMacQuitChord } from './macos-quit-chord-watch'
import type { HoldQuitInput, HoldQuitNotice } from '../../shared/mac-hold-quit'
import { isHoldQuitChord } from '../../shared/mac-hold-quit'
import { keybindingMatchesInput, type KeybindingOverrides } from '../../shared/keybindings'
import { readDevToolsShortcutInput } from '../browser/browser-guest-devtools-close-shortcut'
import { onNativePopupQuitSurfaceChanged } from '../browser/native-browser-popup-windows'
import {
  getDesktopHoldQuitInspectee as inspecteeFor,
  getDesktopHoldQuitSurface as ownerFor,
  hasFocusedDesktopHoldQuitSurface,
  isDesktopHoldQuitSurfaceFocused as focused
} from './desktop-hold-quit-surface'

export function installDesktopHoldQuit(options: {
  store: Pick<Store, 'getSettings' | 'onSettingsChanged'>
  isActivityOwner: (sender: WebContents) => boolean
  isUIRenderer: (sender: WebContents) => boolean
  isLocalWorkActive: () => boolean
  getKeybindings?: () => KeybindingOverrides | undefined
  quit: () => void
  rebuildMenu: () => void
}): () => void {
  if (process.platform !== 'darwin') {
    return () => {}
  }
  const gestures = new Map<WebContents, HoldQuitGesture>()
  const recorders = new Set<number>()
  const detachments = new Map<WebContents, () => void>()
  let activityOwner: WebContents | null = null
  let busy = false
  let disposed = false
  let hadSurface = hasFocusedDesktopHoldQuitSurface()
  const routingWindows = new Map<BaseWindow, () => void>()
  const enabled = (): boolean => options.store.getSettings().holdQuitWhileAgentsWork === true
  const chordOwned = (): boolean =>
    Object.values(options.getKeybindings?.() ?? {}).some((bindings) =>
      bindings?.some((binding) =>
        keybindingMatchesInput(binding, { code: 'KeyQ', key: 'q', meta: true }, 'darwin')
      )
    )
  const refresh = (): void => {
    for (const gesture of gestures.values()) {
      gesture.refresh()
    }
  }
  const refreshRouting = (): void => {
    if (disposed) {
      return
    }
    const windows = new Set<BaseWindow>()
    for (const contents of webContents.getAllWebContents()) {
      const owner = ownerFor(contents)
      if (owner) {
        windows.add(owner.window)
      }
    }
    for (const [window, detach] of routingWindows) {
      if (!windows.has(window)) {
        detach()
        routingWindows.delete(window)
      }
    }
    for (const window of windows) {
      if (!routingWindows.has(window)) {
        window.on('focus', refreshRouting)
        window.on('blur', refreshRouting)
        window.on('show', refreshRouting)
        window.on('hide', refreshRouting)
        window.on('minimize', refreshRouting)
        window.on('restore', refreshRouting)
        window.on('closed', refreshRouting)
        routingWindows.set(window, () => {
          window.off('focus', refreshRouting)
          window.off('blur', refreshRouting)
          window.off('show', refreshRouting)
          window.off('hide', refreshRouting)
          window.off('minimize', refreshRouting)
          window.off('restore', refreshRouting)
          window.off('closed', refreshRouting)
        })
      }
    }
    const hasSurface = hasFocusedDesktopHoldQuitSurface()
    if (hasSurface !== hadSurface) {
      hadSurface = hasSurface
      if (enabled()) {
        options.rebuildMenu()
      }
    }
  }
  const activity = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (!options.isActivityOwner(event.sender) || typeof value !== 'boolean') {
      return
    }
    activityOwner = event.sender
    busy = value
    refresh()
  }
  const recording = (event: Electron.IpcMainEvent, value: unknown): void => {
    if (!options.isUIRenderer(event.sender)) {
      return
    }
    if (value === true) {
      recorders.add(event.sender.id)
    } else {
      recorders.delete(event.sender.id)
    }
    refresh()
  }
  ipcMain.on('ui:holdQuitActivity', activity)
  ipcMain.on('ui:setShortcutRecorderFocused', recording)

  const attach = (contents: WebContents): void => {
    let lastNotice: ((notice: HoldQuitNotice) => void) | null = null
    const sendNotice = (notice: HoldQuitNotice): void => {
      const target = ownerFor(contents)?.notice ?? lastNotice
      lastNotice = notice.phase === 'dismissed' ? null : target
      target?.(notice)
    }
    const gesture = new HoldQuitGesture({
      isEnabled: enabled,
      isBusy: () => busy || options.isLocalWorkActive(),
      isFocused: () => focused(contents),
      isRecording: () => {
        const owner = ownerFor(contents)
        return chordOwned() || Boolean(owner?.renderer && recorders.has(owner.renderer.id))
      },
      quit: options.quit,
      notice: sendNotice,
      watch: watchMacQuitChord
    })
    gestures.set(contents, gesture)
    let boundWindow: BaseWindow | null = null
    const cancel = (): void => gesture.cancel()
    const bindWindow = (): void => {
      const owner = ownerFor(contents)?.window ?? null
      if (owner === boundWindow) {
        return
      }
      boundWindow?.off('blur', cancel)
      boundWindow?.off('closed', cancel)
      boundWindow = owner
      boundWindow?.on('blur', cancel)
      boundWindow?.on('closed', cancel)
    }
    // Native chord sampling survives Chromium suppressing releases after a consumed press.
    const onInput = (event: Electron.Event, input: HoldQuitInput): void => {
      if (!enabled()) {
        gesture.cancel()
        return
      }
      if (isAgentInjectingInput(contents)) {
        return
      }
      if (!isHoldQuitChord(input)) {
        gesture.input(input)
        return
      }
      bindWindow()
      if (chordOwned()) {
        gesture.cancel()
        return
      }
      const owner = ownerFor(contents)
      if (
        input.type === 'keyDown' &&
        enabled() &&
        focused(contents) &&
        owner &&
        !(owner.renderer && recorders.has(owner.renderer.id))
      ) {
        event.preventDefault()
      }
      gesture.input(input)
    }
    const devToolsInput = (event: Electron.Event, inputEvent: Electron.InputEvent): void => {
      if (!enabled() || inputEvent.type !== 'rawKeyDown') {
        return
      }
      const input = readDevToolsShortcutInput(inputEvent)
      if (!input) {
        return
      }
      const keyDown = { ...input, type: 'keyDown', isAutoRepeat: false }
      if (!isHoldQuitChord(keyDown) || inspecteeFor(contents)) {
        onInput(event, keyDown)
      }
    }
    const resetRenderer = (): void => {
      recorders.delete(contents.id)
      gesture.cancel()
      if (activityOwner === contents) {
        busy = false
        activityOwner = null
      }
      refresh()
    }
    const navigating = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && !isInPlace) {
        resetRenderer()
      }
    }
    contents.prependListener('before-input-event', onInput)
    contents.on('input-event', devToolsInput)
    contents.on('did-finish-load', bindWindow)
    contents.on('did-finish-load', refreshRouting)
    contents.on('devtools-opened', refreshRouting)
    contents.on('devtools-closed', refreshRouting)
    contents.on('focus', refreshRouting)
    contents.on('blur', cancel)
    contents.on('blur', refreshRouting)
    contents.on('render-process-gone', resetRenderer)
    contents.on('did-start-navigation', navigating)
    const detach = (): void => {
      gesture.cancel()
      gestures.delete(contents)
      detachments.delete(contents)
      contents.off('before-input-event', onInput)
      contents.off('input-event', devToolsInput)
      contents.off('did-finish-load', bindWindow)
      contents.off('did-finish-load', refreshRouting)
      contents.off('devtools-opened', refreshRouting)
      contents.off('devtools-closed', refreshRouting)
      contents.off('focus', refreshRouting)
      contents.off('blur', cancel)
      contents.off('blur', refreshRouting)
      contents.off('render-process-gone', resetRenderer)
      contents.off('did-start-navigation', navigating)
      contents.off('destroyed', detach)
      boundWindow?.off('blur', cancel)
      boundWindow?.off('closed', cancel)
      recorders.delete(contents.id)
      if (activityOwner === contents) {
        busy = false
        activityOwner = null
        refresh()
      }
      refreshRouting()
    }
    detachments.set(contents, detach)
    contents.once('destroyed', detach)
  }
  const created = (_event: Electron.Event, contents: WebContents): void => {
    attach(contents)
    refreshRouting()
  }
  app.on('web-contents-created', created)
  app.on('browser-window-created', refreshRouting)
  const unsubscribePopups = onNativePopupQuitSurfaceChanged(refreshRouting)
  for (const contents of webContents.getAllWebContents()) {
    attach(contents)
  }
  refreshRouting()
  const unsubscribe = options.store.onSettingsChanged((updates) => {
    if ('holdQuitWhileAgentsWork' in updates) {
      refresh()
      options.rebuildMenu()
    }
  })
  const cancelAll = (): void => {
    for (const gesture of gestures.values()) {
      gesture.cancel()
    }
  }
  app.on('before-quit', cancelAll)
  return () => {
    disposed = true
    cancelAll()
    for (const detach of detachments.values()) {
      detach()
    }
    unsubscribe()
    unsubscribePopups()
    for (const detach of routingWindows.values()) {
      detach()
    }
    routingWindows.clear()
    app.off('web-contents-created', created)
    app.off('browser-window-created', refreshRouting)
    app.off('before-quit', cancelAll)
    ipcMain.off('ui:holdQuitActivity', activity)
    ipcMain.off('ui:setShortcutRecorderFocused', recording)
  }
}
