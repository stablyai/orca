import { useCallback, useEffect, useRef, useState } from 'react'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/MobileSwitch'
import { SettingsSection } from '../settings/settings-screen-frame'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  loadTerminalKeyboardResizeEnabled,
  saveTerminalKeyboardResizeEnabled
} from '../storage/preferences'

export function TerminalKeyboardResizeSetting(): React.JSX.Element {
  const t = useMobileTranslation()
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
    <SettingsSection
      title={t('terminal.keyboardResize.heading', 'KEYBOARD LAYOUT')}
      footer={t(
        'terminal.keyboardResize.description',
        'Fit the terminal above the on-screen keyboard. Opening or closing the keyboard makes running programs redraw. A desktop showing the phone-sized terminal resizes with it.'
      )}
    >
      <ListRow
        key="keyboardResize"
        title={t('terminal.keyboardResize.label', 'Resize terminal for keyboard')}
        accessory={
          <MobileSwitch
            accessibilityLabel={t('terminal.keyboardResize.label', 'Resize terminal for keyboard')}
            value={enabled}
            onValueChange={toggle}
          />
        }
      />
    </SettingsSection>
  )
}
