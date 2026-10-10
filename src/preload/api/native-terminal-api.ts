import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import type { NativeTerminalEvent, NativeTerminalFrame } from '../../shared/native-terminal-ipc'
import type { NativeTerminalForwardedChord } from '../../shared/native-terminal-forwarded-chords'

export type NativeTerminalApi = {
  isSupported: () => Promise<boolean>
  // The label is what VoiceOver calls the surface, in Orca's UI language.
  create: (
    appearance: NativeTerminalAppearance,
    zoomFactor: number,
    accessibilityLabel: string
  ) => Promise<number | null>
  // True when main feeds the surface this PTY's output itself; false keeps the renderer mirror.
  bindPty: (surfaceId: number, ptyId: string) => Promise<boolean>
  write: (surfaceId: number, data: string) => void
  setFrames: (frames: NativeTerminalFrame[]) => void
  focus: (surfaceId: number) => void
  readSelection: (surfaceId: number) => Promise<string | null>
  setAppearance: (appearance: NativeTerminalAppearance, zoomFactor: number) => void
  setForwardedChords: (chords: NativeTerminalForwardedChord[]) => void
  releaseKeyboard: () => void
  setSurfaceAppearance: (
    surfaceId: number,
    appearance: NativeTerminalAppearance,
    zoomFactor: number
  ) => void
  // The surface shows a pty this Mac hosts; its tty drives Secure Keyboard Entry.
  bindLocalPty: (surfaceId: number, ptyId: string) => void
  destroy: (surfaceId: number) => void
  onEvent: (callback: (event: NativeTerminalEvent) => void) => () => void
}
