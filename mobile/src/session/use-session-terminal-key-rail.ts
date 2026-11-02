import { useMemo, useState } from 'react'
import type {
  BridgeTerminalKeyId,
  BridgeTerminalToolbar
} from '../mobile-web-shell/bridge/bridge-terminal-key'
import { sessionCommandDockShown } from './mobile-session-command-dock-shown'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { isMobileTerminalTabRunningAgent } from './mobile-terminal-tab-agent'
import { useShellTerminalKeyRail } from './shell-terminal-key-rail'
import type { MobileSessionController } from './use-mobile-session-controller'

const ESC = '\x1b'
const CTRL_C = '\x03'

/**
 * Hands the terminal's key row to the shell's side rail where the window has one (the iPhone Duo)
 * and sends each press as the row would. `keysInRail` drops the row while the rail shows it.
 */
export function useSessionTerminalKeyRail(controller: MobileSessionController): {
  keysInRail: boolean
  moreKeysVisible: boolean
  closeMoreKeys: () => void
} {
  const {
    activeHandle,
    activeSessionTab,
    terminalModes,
    canSend,
    canCompose,
    liveInputEnabled,
    keyboardHeight,
    keyboardLift,
    directionPadEnabled,
    dockKeys
  } = controller
  const [moreKeysVisible, setMoreKeysVisible] = useState(false)
  const railShown =
    sessionCommandDockShown(controller) &&
    !controller.showCustomKeyModal &&
    !controller.deleteKeyTarget
  const keyboardVisible = keyboardHeight > 0 || keyboardLift > 0
  const runsAgent =
    activeSessionTab?.type === 'terminal' && isMobileTerminalTabRunningAgent(activeSessionTab)
  const phoneDisplayMode = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  const { modifiers } = dockKeys
  const toolbar = useMemo<BridgeTerminalToolbar>(
    () => ({
      canSend,
      canCompose,
      keyboardVisible,
      liveInputEnabled,
      phoneDisplayMode,
      runsAgent,
      modifiers,
      directionPadEnabled
    }),
    [
      canSend,
      canCompose,
      keyboardVisible,
      liveInputEnabled,
      phoneDisplayMode,
      runsAgent,
      modifiers,
      directionPadEnabled
    ]
  )
  const railKeys = useShellTerminalKeyRail(
    railShown,
    (id: BridgeTerminalKeyId) => {
      // A press queued for a terminal that is no longer active must not land on the new one.
      if (!railShown || controller.activeHandleRef.current !== activeHandle) {
        return
      }
      if (id === 'toggleKeyboard') {
        if (keyboardVisible) {
          controller.dismissSoftwareKeyboard()
        } else if (liveInputEnabled ? canSend : canCompose) {
          const field = liveInputEnabled ? controller.liveInputRef : controller.commandInputRef
          field.current?.focus()
        }
        return
      }
      if (id === 'toggleInputMode') {
        if (canCompose) {
          controller.toggleLiveInput()
        }
        return
      }
      if (id === 'moreKeys') {
        setMoreKeysVisible(true)
        return
      }
      if (!canSend) {
        return
      }
      if (id === 'toggleDisplayMode') {
        if (activeHandle) {
          void controller.toggleDisplayMode(activeHandle)
        }
      } else if (id === 'ctrl' || id === 'alt' || id === 'shift') {
        dockKeys.tapModifier(id)
      } else if (id === 'shiftTab') {
        void controller.handleAccessoryKey({ bytes: `${ESC}[Z` })
      } else if (id === 'ctrlC') {
        void controller.handleAccessoryKey({ bytes: CTRL_C })
      } else {
        dockKeys.sendKey(id.startsWith('char:') ? id.slice('char:'.length) : id)
      }
    },
    activeHandle,
    toolbar
  )
  return {
    keysInRail: railKeys.length > 0,
    moreKeysVisible,
    closeMoreKeys: () => setMoreKeysVisible(false)
  }
}
