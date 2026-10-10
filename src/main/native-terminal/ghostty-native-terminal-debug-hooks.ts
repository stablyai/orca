import { app } from 'electron'
import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'
import {
  loadGhosttyTerminalAddon,
  type GhosttyTerminalAddon
} from './ghostty-native-terminal-addon'
import { nativeTerminalFeedDebug } from './ghostty-native-terminal-pty-feed'

type DebugHookSources = {
  surfaceIds: () => number[]
  addon: () => GhosttyTerminalAddon | null
  forwardedChords: () => NativeTerminalForwardedChord[]
}

// Unpackaged builds only: lets E2E drive and inspect surfaces through electronApp.evaluate.
export function installGhosttyDebugHooks(sources: DebugHookSources): void {
  if (app.isPackaged) {
    return
  }
  const { addon } = sources
  Object.assign(globalThis, {
    __orcaNativeTerminalDebug: {
      surfaceIds: sources.surfaceIds,
      state: (surfaceId: number) => addon()?.debugState(surfaceId) ?? null,
      grid: (surfaceId: number) => addon()?.gridSize(surfaceId) ?? null,
      screenText: (surfaceId: number) => addon()?.debugScreenText(surfaceId) ?? null,
      snapshotBase64: (surfaceId: number) =>
        addon()?.debugSnapshot(surfaceId)?.toString('base64') ?? null,
      key: (surfaceId: number, characters: string, keyCode: number, modifierFlags = 0) =>
        addon()?.debugKey(surfaceId, characters, keyCode, modifierFlags),
      scrollbar: (surfaceId: number) => addon()?.debugState(surfaceId)?.scrollbar ?? null,
      scrollbarScroll: (surfaceId: number, fraction: number) =>
        addon()?.debugScrollbarScroll(surfaceId, fraction) ?? false,
      focus: (surfaceId: number) => addon()?.focus(surfaceId),
      action: (surfaceId: number, action: string) => addon()?.performAction(surfaceId, action),
      modifiersChanged: (surfaceId: number, keyCode: number, modifierFlags: number) =>
        addon()?.debugModifiersChanged(surfaceId, keyCode, modifierFlags),
      drop: (surfaceId: number, paths: string[]) => addon()?.debugDrop(surfaceId, paths) ?? null,
      dropOutcome: () => addon()?.debugDropOutcome() ?? null,
      flags: (surfaceId: number, keyCode: number, modifierFlags: number) =>
        addon()?.debugFlags(surfaceId, keyCode, modifierFlags),
      insertText: (surfaceId: number, text: string) => addon()?.debugInsertText(surfaceId, text),
      markedText: (surfaceId: number, text: string | null, caret = 0) =>
        addon()?.debugMarkedText(surfaceId, text, caret) ?? null,
      imeRect: (surfaceId: number, location = 0) =>
        addon()?.debugImeRect(surfaceId, location) ?? null,
      services: (surfaceId: number, op: 'validate' | 'write' | 'read', text?: string) =>
        addon()?.debugServices(surfaceId, op, text) ?? null,
      accessibility: (surfaceId: number) => addon()?.debugAccessibility(surfaceId) ?? null,
      accessibilitySet: (surfaceId: number, attribute: 'selectedText' | 'value', text: string) =>
        addon()?.debugAccessibilitySet(surfaceId, attribute, text),
      secureInput: (surfaceId: number, simulate?: boolean) =>
        addon()?.debugSecureInput(surfaceId, simulate) ?? null,
      textInputMenu: () => addon()?.debugTextInputMenu() ?? [],
      // Loads without initializing Ghostty, so xterm-only baselines can read it too.
      processUsage: (pid: number) => loadGhosttyTerminalAddon()?.debugProcessUsage(pid) ?? null,
      counters: () => addon()?.debugCounters() ?? null,
      windowOcclusion: (onScreen: boolean | null) => addon()?.debugWindowOcclusion(onScreen),
      releaseKeyboard: (surfaceIds: number[]) => addon()?.releaseKeyboard(surfaceIds),
      forwardedChords: sources.forwardedChords,
      mainFeed: nativeTerminalFeedDebug
    }
  })
}
