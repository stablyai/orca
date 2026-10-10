import { ipcMain } from 'electron'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import type { NativeTerminalFrame } from '../../shared/native-terminal-ipc'
import { isNativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import { localPtyShellPid } from '../native-terminal/ghostty-native-terminal-tty'
import {
  createSurface,
  destroyOwnedSurface,
  focusSurface,
  installNativeTerminalDebugHooks,
  isNativeTerminalSupported,
  readSurfaceSelection,
  releaseSurfaceKeyboard,
  setForwardedChords,
  setSurfaceShellPid,
  setSurfaceFrames,
  updateAppearance,
  ownedSurfaceAddon,
  writeSurfaceOutput
} from '../native-terminal/ghostty-native-terminal-host'
import { applyGhosttySurfaceConfig } from '../native-terminal/ghostty-native-terminal-surface-configs'
import {
  bindNativeTerminalPty,
  type NativeTerminalFeedRuntime
} from '../native-terminal/ghostty-native-terminal-pty-feed'

function isAppearance(value: unknown): value is NativeTerminalAppearance {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fontFamily' in value &&
    typeof value.fontFamily === 'string' &&
    'fontSize' in value &&
    typeof value.fontSize === 'number' &&
    'theme' in value &&
    typeof value.theme === 'object' &&
    value.theme !== null
  )
}

function isSurfaceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

// The renderer merges overlapping holes; more than this many means it should have hidden.
const MAX_FRAME_HOLES = 16

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isHoleList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_FRAME_HOLES &&
    value.every(
      (hole) =>
        Array.isArray(hole) &&
        hole.length === 4 &&
        hole.every(isFiniteNumber) &&
        hole[2] >= 0 &&
        hole[3] >= 0
    )
  )
}

function isFrame(value: unknown): value is NativeTerminalFrame {
  return (
    Array.isArray(value) &&
    (value.length === 6 || (value.length === 7 && isHoleList(value[6]))) &&
    isSurfaceId(value[0]) &&
    value.slice(1, 5).every(isFiniteNumber) &&
    typeof value[5] === 'boolean'
  )
}

function zoomOf(value: unknown): number {
  return typeof value === 'number' && value > 0 && Number.isFinite(value) ? value : 1
}

const INVOKE_CHANNELS = [
  'nativeTerminal:isSupported',
  'nativeTerminal:create',
  'nativeTerminal:readSelection',
  'nativeTerminal:bindPty'
]
const SEND_CHANNELS = [
  'nativeTerminal:write',
  'nativeTerminal:setFrames',
  'nativeTerminal:focus',
  'nativeTerminal:setAppearance',
  'nativeTerminal:setForwardedChords',
  'nativeTerminal:releaseKeyboard',
  'nativeTerminal:setSurfaceAppearance',
  'nativeTerminal:bindLocalPty',
  'nativeTerminal:destroy'
]

export function registerNativeTerminalHandlers(
  runtime: NativeTerminalFeedRuntime | null = null
): void {
  installNativeTerminalDebugHooks()
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  for (const channel of SEND_CHANNELS) {
    ipcMain.removeAllListeners(channel)
  }
  ipcMain.handle('nativeTerminal:isSupported', (): boolean => isNativeTerminalSupported())
  ipcMain.handle(
    'nativeTerminal:create',
    (event, appearance: unknown, zoomFactor: unknown, label: unknown): number | null => {
      if (!isAppearance(appearance)) {
        return null
      }
      const zoom = zoomOf(zoomFactor)
      const accessibilityLabel =
        typeof label === 'string' && label.length > 0 && label.length <= 80 ? label : null
      const surfaceId = createSurface(event.sender, appearance, zoom, accessibilityLabel)
      // The new surface starts on its pane's own config, before its first frame.
      const native = surfaceId === null ? null : ownedSurfaceAddon(event.sender, surfaceId)
      if (native && surfaceId !== null) {
        applyGhosttySurfaceConfig(native, surfaceId, appearance, zoom)
      }
      return surfaceId
    }
  )
  ipcMain.on('nativeTerminal:write', (event, surfaceId: unknown, data: unknown) => {
    if (isSurfaceId(surfaceId) && typeof data === 'string') {
      writeSurfaceOutput(event.sender, surfaceId, data)
    }
  })
  ipcMain.on('nativeTerminal:setFrames', (event, frames: unknown) => {
    if (Array.isArray(frames)) {
      setSurfaceFrames(event.sender, frames.filter(isFrame))
    }
  })
  ipcMain.on('nativeTerminal:focus', (event, surfaceId: unknown) => {
    if (isSurfaceId(surfaceId)) {
      focusSurface(event.sender, surfaceId)
    }
  })
  ipcMain.handle(
    'nativeTerminal:bindPty',
    (event, surfaceId: unknown, ptyId: unknown): boolean =>
      isSurfaceId(surfaceId) &&
      typeof ptyId === 'string' &&
      ownedSurfaceAddon(event.sender, surfaceId) !== null &&
      bindNativeTerminalPty(surfaceId, ptyId, runtime)
  )
  ipcMain.handle('nativeTerminal:readSelection', (event, surfaceId: unknown): string | null =>
    isSurfaceId(surfaceId) ? readSurfaceSelection(event.sender, surfaceId) : null
  )
  ipcMain.on('nativeTerminal:setAppearance', (event, appearance: unknown, zoomFactor: unknown) => {
    if (isAppearance(appearance)) {
      updateAppearance(event.sender, appearance, zoomOf(zoomFactor))
    }
  })
  ipcMain.on('nativeTerminal:setForwardedChords', (event, chords: unknown) => {
    if (Array.isArray(chords)) {
      setForwardedChords(event.sender, chords.filter(isNativeTerminalForwardedChord))
    }
  })
  ipcMain.on('nativeTerminal:releaseKeyboard', (event) => releaseSurfaceKeyboard(event.sender))
  ipcMain.on(
    'nativeTerminal:setSurfaceAppearance',
    (event, surfaceId: unknown, appearance: unknown, zoomFactor: unknown) => {
      if (isSurfaceId(surfaceId) && isAppearance(appearance)) {
        const native = ownedSurfaceAddon(event.sender, surfaceId)
        if (native) {
          applyGhosttySurfaceConfig(native, surfaceId, appearance, zoomOf(zoomFactor))
        }
      }
    }
  )
  ipcMain.on('nativeTerminal:bindLocalPty', (event, surfaceId: unknown, ptyId: unknown) => {
    if (isSurfaceId(surfaceId) && typeof ptyId === 'string') {
      void localPtyShellPid(ptyId).then((pid) => setSurfaceShellPid(event.sender, surfaceId, pid))
    }
  })
  ipcMain.on('nativeTerminal:destroy', (event, surfaceId: unknown) => {
    if (isSurfaceId(surfaceId)) {
      destroyOwnedSurface(event.sender, surfaceId)
    }
  })
}
