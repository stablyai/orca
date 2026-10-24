import { logicalKeyTokenFromInput, physicalCodeKeyTokenFromInput } from '../../shared/keybindings'

export function isMacAppPasteInput(input: Electron.Input): boolean {
  return (
    process.platform === 'darwin' &&
    input.type === 'keyDown' &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    // Why: the produced key wins so remapped layouts (Turkish F puts C on KeyV) don't paste; non-Latin and IME keys fall back to the physical key.
    (logicalKeyTokenFromInput(input) ?? physicalCodeKeyTokenFromInput(input)) === 'V'
  )
}
