import '../../i18n/mobile-i18n'

export function isTerminalPhoneDisplayMode(
  handle: string | null,
  terminalModes: ReadonlyMap<string, 'auto' | 'phone' | 'desktop'>
): boolean {
  if (!handle) {
    return false
  }
  const mode = terminalModes.get(handle)
  return mode === undefined || mode === 'auto' || mode === 'phone'
}
