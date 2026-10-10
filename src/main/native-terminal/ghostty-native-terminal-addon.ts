import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'

type SurfacePlacement = [
  surfaceId: number,
  x: number,
  y: number,
  width: number,
  height: number,
  visible: boolean
]

// Holes ([x, y, width, height] in window points) are cut out of the view's mask and hit-testing.
export type NativeSurfaceFrame =
  | SurfacePlacement
  | [...SurfacePlacement, holes: [number, number, number, number][]]

type DebugRect = { x: number; y: number; width: number; height: number }

export type NativeSurfaceEventHandler = (kind: string, ...args: unknown[]) => void

// Rows as Ghostty reports them; hit* name the view a click on / beside the scroller reaches.
export type NativeSurfaceScrollbarState = {
  total: number
  offset: number
  len: number
  visible: boolean
  knobProportion: number
  knobPosition: number
  hitScroller: string
  hitBeside: string
}

export type GhosttyTerminalAddon = {
  init: (configPath: string) => boolean
  updateConfig: (configPath: string) => void
  // Gives one surface a config of its own; app-wide updateConfig then leaves it alone.
  updateSurfaceConfig: (surfaceId: number, configPath: string) => void
  createSurface: (
    windowHandle: Buffer,
    x: number,
    y: number,
    width: number,
    height: number,
    onEvent: NativeSurfaceEventHandler
  ) => number
  writeOutput: (surfaceId: number, data: Buffer) => void
  setFrames: (frames: NativeSurfaceFrame[]) => void
  focus: (surfaceId: number) => void
  setAppFocus: (focused: boolean) => void
  readSelection: (surfaceId: number) => string | null
  performAction: (surfaceId: number, action: string) => boolean
  destroySurface: (surfaceId: number) => void
  gridSize: (surfaceId: number) => { columns: number; rows: number } | null
  releaseKeyboard: (surfaceIds: number[]) => void
  setSurfaceShellPid: (surfaceId: number, pid: number) => string | null
  setSurfaceAccessibilityLabel: (surfaceId: number, label: string) => void
  debugInsertText: (surfaceId: number, text: string) => void
  debugMarkedText: (
    surfaceId: number,
    text: string | null,
    caret: number
  ) => { hasMarkedText: boolean } | null
  debugImeRect: (
    surfaceId: number,
    location: number
  ) => { caret: DebugRect; view: DebugRect } | null
  debugFlags: (surfaceId: number, keyCode: number, modifierFlags: number) => void
  debugServices: (surfaceId: number, op: 'validate' | 'write' | 'read', text?: string) => unknown
  debugAccessibility: (surfaceId: number) => Record<string, unknown> | null
  debugAccessibilitySet: (
    surfaceId: number,
    attribute: 'selectedText' | 'value',
    text: string
  ) => void
  debugSecureInput: (surfaceId: number, simulate?: boolean) => Record<string, unknown>
  debugTextInputMenu: () => { action: string; keyEquivalent: string; modifiers: number }[]
  setForwardedChords: (
    chords: [keyCode: number, modifierFlags: number, character: string][]
  ) => void
  debugKey: (surfaceId: number, characters: string, keyCode: number, modifierFlags: number) => void
  debugModifiersChanged: (surfaceId: number, keyCode: number, modifierFlags: number) => void
  debugDrop: (
    surfaceId: number,
    paths: string[]
  ) => { destination: string; operation: number } | null
  debugDropOutcome: () => { performed: boolean; updates: number; operation: number } | null
  debugScreenText: (surfaceId: number) => string | null
  debugSnapshot: (surfaceId: number) => Buffer | null
  debugState: (surfaceId: number) => {
    hidden: boolean
    firstResponder: boolean
    x: number
    y: number
    width: number
    height: number
    scrollbar: NativeSurfaceScrollbarState | null
    windowFirstResponder: string
    ghosttyFocused: boolean
    ghosttyVisible: boolean
    presentedFrames: number
    strayCursorTimers: number
  } | null
  debugScrollbarScroll: (surfaceId: number, fraction: number) => boolean
  debugProcessUsage: (pid: number) => NativeProcessUsage | null
  debugCounters: () => {
    ticks: number
    setFrames: number
    presentedFrames: number
    surfaces: number
  }
  debugWindowOcclusion: (onScreen: boolean | null) => void
}

// proc_pid_rusage of one process: cumulative CPU, wakeups and instructions, current footprint.
export type NativeProcessUsage = {
  userNs: number
  systemNs: number
  interruptWakeups: number
  idleWakeups: number
  instructions: number
  cycles: number
  footprint: number
}

const ADDON_FILE = 'ghostty_terminal.node'
const requireFromMain = createRequire(__filename)
let cached: GhosttyTerminalAddon | null | undefined

function candidatePaths(): string[] {
  if (getAppEnvironment().isPackaged()) {
    return [join(process.resourcesPath, 'ghostty-terminal-macos', ADDON_FILE)]
  }
  // Dev and E2E run the bundle from out/main; the addon is built in the repo.
  return [
    join(__dirname, '../../native/ghostty-terminal-macos/build', ADDON_FILE),
    join(getAppEnvironment().getAppPath(), 'native/ghostty-terminal-macos/build', ADDON_FILE)
  ]
}

export function loadGhosttyTerminalAddon(): GhosttyTerminalAddon | null {
  if (cached !== undefined) {
    return cached
  }
  cached = null
  if (process.platform !== 'darwin') {
    return cached
  }
  const path = candidatePaths().find((candidate) => existsSync(candidate))
  if (!path) {
    return cached
  }
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the addon's exports are defined in native/ghostty-terminal-macos/src/ghostty_terminal.mm and mirror this type.
    cached = requireFromMain(path) as GhosttyTerminalAddon
  } catch (error) {
    console.error('[native-terminal] failed to load the Ghostty addon', error)
  }
  return cached
}
