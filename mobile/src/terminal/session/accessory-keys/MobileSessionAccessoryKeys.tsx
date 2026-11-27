import { useEffect, useMemo, useState } from 'react'
import { View } from 'react-native'
import { createTerminalLiveAccessoryInput } from '../../live-input/terminal-live-accessory-input'
import { getVisibleTerminalAccessoryBuiltInRows } from '../../key-input/terminal-accessory-layout'
import { useDirectionPadAvailable } from '../../../layout/use-shell-side-rail'
import { isTerminalPhoneDisplayMode } from '../pane-layout/terminal-phone-display-mode'
import { terminalDockStyles as styles } from './terminal-dock-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useKeyboardPersistingTaps } from '../../../platform/keyboard/keyboard-persisting-taps'
import type { MobileSessionController } from '../../../session/use-mobile-session-controller'
import { useMobileSessionKeyboardLift } from '../input-controls/use-mobile-session-keyboard-lift'
import {
  AGENT_SMART_KEY_STEP_MS,
  type AgentSmartKey
} from '../../../../../src/shared/terminal/input/agent-smart-keys'
import type { TerminalAccessoryKey } from '../../key-input/terminal-accessory-keys'
import { resolveMobileTerminalTabSmartKeys } from '../../../session/tabs/mobile-terminal-tab-agent'
import { MobileSessionAccessoryKeyRow } from './MobileSessionAccessoryKeyRow'

type PreparedPress = ReturnType<MobileSessionController['prepareAccessoryPress']>

/** Terminal shortcut dock above live input supporting 1–4 configurable stacked key rows. */
export function MobileSessionAccessoryKeys({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
  const [rowsCollapsed, setRowsCollapsed] = useState(false)
  const {
    activeHandle,
    customKeys,
    setShowCustomKeyModal,
    setDeleteKeyTarget,
    shortcutLayout,
    visibleBuiltInIds,
    terminalModes,
    canPaste,
    canSend,
    toggleDisplayMode,
    handleAccessoryKey,
    dismissSoftwareKeyboard,
    stopAccessoryRepeat,
    cancelAccessoryRepeat,
    prepareAccessoryPress,
    handlePaste,
    dockKeys,
    activeSessionTab,
    terminals,
    smartRailEnabled
  } = controller
  const keyboardLift = useMobileSessionKeyboardLift(controller.dockBottomInset)
  const latestSmartKeys = useMemo(
    () =>
      smartRailEnabled ? resolveMobileTerminalTabSmartKeys(activeSessionTab, terminals) : null,
    [smartRailEnabled, activeSessionTab, terminals]
  )
  const keepsKeyboard = useKeyboardPersistingTaps('always')
  // An unmounting Pressable never fires onPressOut, so a held key would outlive its row.
  useEffect(() => cancelAccessoryRepeat, [cancelAccessoryRepeat])
  const phoneDisplay = isTerminalPhoneDisplayMode(activeHandle, terminalModes)
  // A D-pad device's layout leaves the arrows to the rail, and this row only shows without the rail.
  const padAvailable = useDirectionPadAvailable()

  const effectiveLayout = useMemo(
    () =>
      shortcutLayout ?? {
        orderedBuiltInIds: visibleBuiltInIds,
        visibleBuiltInIds
      },
    [shortcutLayout, visibleBuiltInIds]
  )
  const builtInRows = useMemo(
    () => getVisibleTerminalAccessoryBuiltInRows(effectiveLayout, padAvailable),
    [effectiveLayout, padAvailable]
  )
  const visibleRows = useMemo(
    () =>
      builtInRows
        .map((keys, slot) => ({ id: `row-${slot}`, keys }))
        .filter((entry, slot) => slot === 0 || entry.keys.length > 0),
    [builtInRows]
  )
  const canCollapseRows = visibleRows.length > 1
  const displayedRows = useMemo(
    () =>
      canCollapseRows && rowsCollapsed
        ? [{ id: 'row-0', keys: visibleRows.flatMap((entry) => entry.keys) }]
        : visibleRows,
    [canCollapseRows, rowsCollapsed, visibleRows]
  )
  const latchRowIndex = useMemo(() => {
    const tabRow = displayedRows.findIndex((entry) => entry.keys.some((key) => key.id === 'tab'))
    return Math.max(tabRow, 0)
  }, [displayedRows])

  // Held Shift, Ctrl or Alt turn a key into its combo and are used up when it sends; keys that take none send as they are.
  const prepareBuiltInPress = (key: TerminalAccessoryKey): PreparedPress => {
    const chord = dockKeys.chordInput(key.id)
    const press = prepareAccessoryPress(chord ?? createTerminalLiveAccessoryInput(key))
    const takeChord = () => {
      if (chord) {
        dockKeys.takeModifiers()
      }
    }
    return {
      tap: () => {
        takeChord()
        return press.tap()
      },
      hold: (firstRepeatDelayMs) => {
        takeChord()
        press.hold(firstRepeatDelayMs)
      }
    }
  }

  // Later writes belong to the same press, so a scroll after release mustn't drop them; a tab switch does.
  const sendSmartKey = (key: AgentSmartKey) => {
    const handle = controller.activeHandleRef.current
    void (async () => {
      for (const [index, bytes] of key.writes.entries()) {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, AGENT_SMART_KEY_STEP_MS))
        }
        if (controller.activeHandleRef.current !== handle) {
          return
        }
        if (!(await prepareAccessoryPress({ bytes }).tap())) {
          return
        }
      }
    })()
  }

  return (
    <View ref={keepsKeyboard} style={styles.keyRowsStack}>
      {displayedRows.map((entry, index) => (
        <MobileSessionAccessoryKeyRow
          key={entry.id}
          rowKeys={entry.keys}
          isFirstRow={index === 0}
          isLastRow={index === displayedRows.length - 1}
          showKeyboardDismiss={keyboardLift > 0}
          onDismissKeyboard={dismissSoftwareKeyboard}
          canCollapseRows={canCollapseRows}
          rowsCollapsed={rowsCollapsed}
          onToggleCollapseRows={() => setRowsCollapsed((prev) => !prev)}
          latestSmartKeys={latestSmartKeys}
          canSend={canSend}
          phoneDisplay={phoneDisplay}
          hasActiveHandle={activeHandle !== null}
          onToggleDisplayMode={() => {
            if (activeHandle) {
              void toggleDisplayMode(activeHandle)
            }
          }}
          canPaste={canPaste}
          onPaste={() => void handlePaste()}
          modifiers={dockKeys.modifiers}
          onTapModifier={dockKeys.tapModifier}
          includeLatchKeys={index === latchRowIndex}
          customKeys={customKeys}
          onPressCustomKey={(key) => void handleAccessoryKey({ bytes: key.bytes })}
          onDeleteCustomKey={setDeleteKeyTarget}
          onAddCustomKey={() => setShowCustomKeyModal(true)}
          prepareBuiltInPress={prepareBuiltInPress}
          stopAccessoryRepeat={stopAccessoryRepeat}
          cancelAccessoryRepeat={cancelAccessoryRepeat}
          sendSmartKey={sendSmartKey}
        />
      ))}
    </View>
  )
}
