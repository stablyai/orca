import { useCallback, useEffect, useRef, useState } from 'react'
import { Switch, Text, View } from 'react-native'
import {
  loadTerminalKeyboardResizeEnabled,
  saveTerminalKeyboardResizeEnabled
} from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { terminalSettingsScreenStyles as styles } from './terminal-settings-screen-styles'

export function TerminalKeyboardResizeSetting(): React.JSX.Element {
  const [enabled, setEnabled] = useState(false)
  const userToggledRef = useRef(false)
  const toggleSeqRef = useRef(0)

  useEffect(() => {
    let stale = false
    void loadTerminalKeyboardResizeEnabled().then((storedEnabled) => {
      // Why: a toggle made before storage answered must not be overwritten by the stored value.
      if (!stale && !userToggledRef.current) {
        setEnabled(storedEnabled)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  const toggle = useCallback((next: boolean) => {
    userToggledRef.current = true
    const seq = ++toggleSeqRef.current
    setEnabled(next)
    void saveTerminalKeyboardResizeEnabled(next).catch(() => {
      // Why: a refused write must not leave the switch claiming a value the session will not
      // load on return; the read-back lands the switch on what storage actually kept. It applies
      // only while this toggle is still the latest — a newer toggle owns the switch and resolves
      // through its own save or read-back.
      void loadTerminalKeyboardResizeEnabled().then((storedEnabled) => {
        if (seq === toggleSeqRef.current) {
          setEnabled(storedEnabled)
        }
      })
    })
  }, [])

  return (
    <>
      <Text style={[styles.groupHeading, styles.inputGroupGap]}>KEYBOARD LAYOUT</Text>
      <Text style={styles.groupDescription}>
        Shrink the terminal to the space above the on-screen keyboard instead of sliding it up. Each
        keyboard open or close resizes the terminal, so running programs redraw, and a desktop
        showing this phone-sized terminal resizes with it.
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        <View style={styles.row}>
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Resize terminal for keyboard</Text>
            <Text style={styles.rowSublabel}>{enabled ? 'On' : 'Off'}</Text>
          </View>
          <Switch
            accessibilityLabel="Resize terminal for keyboard"
            value={enabled}
            onValueChange={toggle}
            trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
            thumbColor={colors.textPrimary}
          />
        </View>
      </View>
    </>
  )
}
