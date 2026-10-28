import { logicalKeyTokenFromInput, physicalCodeKeyTokenFromInput } from '../../shared/keybindings'

export function isMacAppPasteInput(input: Electron.Input): boolean {
  return (
    process.platform === 'darwin' &&
    input.type === 'keyDown' &&
    input.meta &&
    !input.control &&
    !input.alt &&
    !input.shift &&
    // Produced keys override physical codes for remapped layouts; non-Latin/IME keys fall back to code.
    (logicalKeyTokenFromInput(input) ?? physicalCodeKeyTokenFromInput(input)) === 'V'
  )
}
