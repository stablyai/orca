import { SPECIAL_KEY_LABELS } from '../terminal/terminal-key-definitions'
import { createTerminalLiveAccessoryInput } from '../terminal/terminal-live-accessory-input'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import { isMobileTerminalTabRunningAgent } from './mobile-terminal-tab-agent'
import { TerminalMoreKeysSheet } from './TerminalMoreKeysSheet'
import type { MobileSessionController } from './use-mobile-session-controller'

const ARROW_IDS = ['arrowUp', 'arrowDown', 'arrowLeft', 'arrowRight']
// Built-in keys each row already shows; the ⋯ sheet offers the rest.
const SHELL_ROW_KEY_IDS: ReadonlySet<string> = new Set(['escape', 'tab', ...ARROW_IDS])
const AGENT_ROW_KEY_IDS: ReadonlySet<string> = new Set([
  'escape',
  'shiftTab',
  'enter',
  'ctrlC',
  ...ARROW_IDS
])

// The ⋯ sheet of the terminal's key row, opened from the row or from the Duo's side rail.
export function MobileTerminalMoreKeysSheet({
  controller,
  visible,
  onClose
}: {
  controller: MobileSessionController
  visible: boolean
  onClose: () => void
}) {
  const {
    activeHandle,
    activeSessionTab,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    visibleBuiltInAccessoryKeys,
    terminalModes,
    canPaste,
    canSend,
    isAttaching,
    attachImage,
    toggleDisplayMode,
    handleAccessoryKey,
    dockKeys: keys,
    handlePaste
  } = controller
  const runsAgent =
    activeSessionTab?.type === 'terminal' && isMobileTerminalTabRunningAgent(activeSessionTab)
  return (
    <TerminalMoreKeysSheet
      visible={visible}
      onClose={onClose}
      canSend={canSend}
      canPaste={canPaste}
      isAttaching={isAttaching}
      phoneDisplay={isTerminalPhoneDisplayMode(activeHandle, terminalModes)}
      rowKeyIds={runsAgent ? AGENT_ROW_KEY_IDS : SHELL_ROW_KEY_IDS}
      builtInKeys={visibleBuiltInAccessoryKeys}
      customKeys={customKeys}
      onPaste={() => void handlePaste()}
      onAttachImage={() => void attachImage('library')}
      onAttachFile={() => void attachImage('files')}
      onToggleDisplay={() => {
        if (activeHandle) {
          void toggleDisplayMode(activeHandle)
        }
      }}
      onBuiltInKey={(key) =>
        SPECIAL_KEY_LABELS[key.id]
          ? keys.sendKey(key.id)
          : void handleAccessoryKey(createTerminalLiveAccessoryInput(key))
      }
      onSpecialKey={keys.sendKey}
      onCustomKey={(key) => void handleAccessoryKey({ bytes: key.bytes })}
      onDeleteCustomKey={setDeleteKeyTarget}
      onAddCustomKey={() => setShowCustomKeyModal(true)}
    />
  )
}
