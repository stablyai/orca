import { useCallback, useEffect, useRef } from 'react'
import type { HardwareKeyboardCommandEvent } from '@orca/expo-hardware-keyboard-navigation'
import type { MobileSessionTabSwitchingModel } from '../session/use-mobile-session-tab-switching'
import { MOBILE_TAB_KEYBOARD_ACTIONS } from './mobile-hardware-keyboard-actions'
import {
  getIndexedKeyboardTab,
  getRelativeKeyboardTab,
  MobileRecentTabOrder,
  type MobileTabCycleMode
} from './mobile-tab-keyboard-navigation'
import { useMobileHardwareKeyboardCommands } from './use-mobile-hardware-keyboard-commands'
import { usePublishMobileSessionHardwareKeyboardContext } from './mobile-session-hardware-keyboard-context'

export function useMobileSessionKeyboardNavigation(scope: MobileSessionTabSwitchingModel): void {
  const { activeSessionTabId, sessionTabs, switchSessionTab } = scope
  const recentRef = useRef(new MobileRecentTabOrder())
  const activeTab = sessionTabs.find((tab) => tab.id === activeSessionTabId) ?? null
  const context = activeTab?.type === 'terminal' ? 'terminal' : 'app'

  usePublishMobileSessionHardwareKeyboardContext({
    context,
    hostId: scope.hostId,
    worktreeId: scope.worktreeId
  })

  useEffect(() => {
    if (activeSessionTabId) {
      recentRef.current.record(activeSessionTabId)
    }
  }, [activeSessionTabId])

  const handleCommand = useCallback(
    (event: HardwareKeyboardCommandEvent) => {
      const directionAndMode = commandCycle(event.actionId)
      if (directionAndMode) {
        const target = getRelativeKeyboardTab({
          tabs: sessionTabs,
          activeTabId: activeSessionTabId,
          ...directionAndMode
        })
        if (target) {
          switchSessionTab(target)
        }
        return
      }
      if (event.actionId === 'tab.selectByIndex') {
        const target = getIndexedKeyboardTab(sessionTabs, Number(event.key))
        if (target && target.id !== activeSessionTabId) {
          switchSessionTab(target)
        }
        return
      }
      if (event.actionId === 'tab.previousRecent') {
        const targetId = recentRef.current.previous(
          activeSessionTabId,
          new Set(sessionTabs.map((tab) => tab.id))
        )
        const target = sessionTabs.find((tab) => tab.id === targetId)
        if (target) {
          switchSessionTab(target)
        }
      }
    },
    [activeSessionTabId, sessionTabs, switchSessionTab]
  )

  useMobileHardwareKeyboardCommands({
    actionIds: MOBILE_TAB_KEYBOARD_ACTIONS,
    context,
    onCommand: handleCommand
  })
}

function commandCycle(actionId: string): { direction: -1 | 1; mode: MobileTabCycleMode } | null {
  switch (actionId) {
    case 'tab.previousAllTypes':
      return { direction: -1, mode: 'all' }
    case 'tab.nextAllTypes':
      return { direction: 1, mode: 'all' }
    case 'tab.previousSameType':
      return { direction: -1, mode: 'same-type' }
    case 'tab.nextSameType':
      return { direction: 1, mode: 'same-type' }
    case 'tab.previousTerminal':
      return { direction: -1, mode: 'terminal' }
    case 'tab.nextTerminal':
      return { direction: 1, mode: 'terminal' }
    default:
      return null
  }
}
