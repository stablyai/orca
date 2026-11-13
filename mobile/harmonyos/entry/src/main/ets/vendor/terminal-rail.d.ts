export interface SideRailStrip {
  side: string
  width: number
  top: number
  bottom: number
  height: number
}

interface Insets { top: number; right: number; bottom: number; left: number }
interface Region { x: number; y: number; width: number; height: number }
interface StripArgs { windowWidth: number; windowHeight: number; insets: Insets; occlusions: Region[] }
interface RepeatController {
  start(input: string, send: (input: string) => Promise<boolean>): void
  cancel(): void
}
declare const terminalRail: {
  getSideRailStrip(args: StripArgs): SideRailStrip | null
  hasTerminalDirectionPadSpace(strip: SideRailStrip | null): boolean
  sideRailStripAboveKeyboard(strip: SideRailStrip | null, keyboardHeight: number): SideRailStrip | null
  createTerminalAccessoryRepeatController(): RepeatController
  TERMINAL_ACCESSORY_REPEAT_DELAY_MS: number
}
export default terminalRail
