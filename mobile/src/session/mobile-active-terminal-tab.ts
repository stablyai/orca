import type { MobileSessionTab } from '../../app/h/[hostId]/session/mobile-session-route-types'

export function getActiveTabIdForHandle(
  tabs: MobileSessionTab[],
  terminalHandle: string | null
): string | null {
  if (!terminalHandle) {
    return null
  }
  return (
    tabs.find(
      (tab): tab is Extract<MobileSessionTab, { type: 'terminal' }> =>
        tab.type === 'terminal' && tab.terminal === terminalHandle
    )?.id ?? terminalHandle
  )
}
