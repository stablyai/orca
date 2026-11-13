import { app, globalShortcut } from 'electron'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  getEffectiveKeybindingsForAction,
  parseKeybinding,
  type KeybindingOverrides
} from '../../shared/keybindings'
import type { KeybindingService } from '../keybindings/keybinding-service'
import type { Store } from '../persistence/loading-store/store'
import { getTrustedUIRendererWebContents, sendToTrustedUIRenderer } from '../ipc/ui'
import { isQuittingForUpdate } from '../updater/updater-service'
import {
  requestFloatingWorkspaceWindowPlacement,
  summonFloatingWorkspaceWindow
} from './floating-workspace-window'
import { isBackgroundLaunch } from './activation/foreground-activation-policy'

const GLOBAL_KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space)$/

/** Electron accelerator for one Orca binding, or null when it cannot be global (no non-Shift modifier, double-tap, other keys). */
export function bindingToGlobalAccelerator(
  binding: string,
  platform: NodeJS.Platform
): string | null {
  const parsed = parseKeybinding(binding)
  if (!parsed || parsed.doubleTapModifier || !GLOBAL_KEY.test(parsed.key)) {
    return null
  }
  if (!(parsed.mod || parsed.meta || parsed.control || parsed.alt)) {
    return null
  }
  return [
    parsed.mod && 'CommandOrControl',
    parsed.meta && (platform === 'darwin' ? 'Command' : 'Super'),
    parsed.control && 'Control',
    parsed.alt && 'Alt',
    parsed.shift && 'Shift',
    parsed.key
  ]
    .filter(Boolean)
    .join('+')
}

export function floatingToggleGlobalAccelerator(
  platform: NodeJS.Platform,
  overrides: KeybindingOverrides | undefined
): string | null {
  for (const binding of getEffectiveKeybindingsForAction(
    'floatingTerminal.toggle',
    platform,
    overrides
  )) {
    const accelerator = bindingToGlobalAccelerator(binding, platform)
    if (accelerator) {
      return accelerator
    }
  }
  return null
}

// Key repeat and a second press while the first show is in flight must not undo it.
const PRESS_DEBOUNCE_MS = 300

type GlobalToggleDeps = {
  store: Pick<Store, 'getSettings' | 'onSettingsChanged'>
  keybindings?: Pick<KeybindingService, 'getOverrides' | 'onChange'>
  getIsQuitting: () => boolean
  hasMainWindow: () => boolean
}

let deps: GlobalToggleDeps | null = null
let registered: string | null = null
let lastPressAt = Number.NEGATIVE_INFINITY
const warned = new Set<string>()

function isPopoutMode(settings: GlobalSettings): boolean {
  return (
    settings.floatingTerminalEnabled === true &&
    settings.experimentalFloatingWorkspacePopout === true &&
    settings.experimentalFloatingWorkspaceMode === 'popout'
  )
}

function isQuitting(current: GlobalToggleDeps): boolean {
  return current.getIsQuitting() || isQuittingForUpdate()
}

function onPress(): void {
  const now = Date.now()
  if (now - lastPressAt < PRESS_DEBOUNCE_MS) {
    return
  }
  lastPressAt = now
  if (
    !deps ||
    isQuitting(deps) ||
    !isPopoutMode(deps.store.getSettings()) ||
    !getTrustedUIRendererWebContents()
  ) {
    return
  }
  if (summonFloatingWorkspaceWindow()) {
    return
  }
  requestFloatingWorkspaceWindowPlacement()
  // Same message as the in-app chord, on the channel the user-hide notice uses, so their order holds.
  sendToTrustedUIRenderer('ui:toggleFloatingTerminal', null)
}

function unregister(): void {
  if (registered) {
    globalShortcut.unregister(registered)
    registered = null
  }
}

/** Register the chord only in Pop-out mode with a main window; a background or test instance never takes it from the desktop. */
export function syncFloatingWorkspaceGlobalToggle(): void {
  const current = deps
  const wanted =
    current &&
    !isQuitting(current) &&
    !isBackgroundLaunch() &&
    current.hasMainWindow() &&
    isPopoutMode(current.store.getSettings())
      ? floatingToggleGlobalAccelerator(process.platform, current.keybindings?.getOverrides())
      : null
  if (wanted === registered) {
    return
  }
  unregister()
  if (!wanted) {
    return
  }
  if (globalShortcut.register(wanted, onPress)) {
    registered = wanted
  } else if (!warned.has(wanted)) {
    warned.add(wanted)
    console.warn(
      `[floating-workspace] ${wanted} is taken by another app; the chord works inside Orca only`
    )
  }
}

/** Bind once per store; main-window open, close and quit-abort call sync themselves. */
export function installFloatingWorkspaceGlobalToggle(next: GlobalToggleDeps): void {
  if (deps?.store === next.store) {
    deps = next
    syncFloatingWorkspaceGlobalToggle()
    return
  }
  deps = next
  const unsubscribeSettings = next.store.onSettingsChanged(syncFloatingWorkspaceGlobalToggle)
  const unsubscribeKeybindings = next.keybindings?.onChange(syncFloatingWorkspaceGlobalToggle)
  // Why unconditional: a later reload or settings write during quit must find the chord gone; a cancelled quit re-syncs.
  app.on('before-quit', unregister)
  app.once('will-quit', () => {
    unsubscribeSettings()
    unsubscribeKeybindings?.()
    app.off('before-quit', unregister)
    unregister()
    deps = null
  })
  syncFloatingWorkspaceGlobalToggle()
}
