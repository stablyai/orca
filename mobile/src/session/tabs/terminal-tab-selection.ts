import '../../i18n/mobile-i18n'

export function getActiveTabIdForHandle(
  tabs: ReadonlyArray<{ id: string; type: string; terminal?: string | null }>,
  terminalHandle: string | null
): string | null {
  if (!terminalHandle) {
    return null
  }
  return (
    tabs.find((tab) => tab.type === 'terminal' && tab.terminal === terminalHandle)?.id ??
    terminalHandle
  )
}
