import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import {
  loadTerminalSplitLayout,
  saveTerminalSplitLayout,
  type TerminalSplitLayout
} from '../storage/preferences'
import { translate } from '../i18n/mobile-i18n'

export function useTerminalSplitLayout() {
  const [terminalSplitLayout, setLayout] = useState<TerminalSplitLayout>('auto')
  const edited = useRef(false)
  useEffect(() => {
    let active = true
    void loadTerminalSplitLayout().then(
      (layout) => {
        if (active && !edited.current) {
          setLayout(layout)
        }
      },
      (error: unknown) => console.warn('Terminal split layout could not be loaded', error)
    )
    return () => {
      active = false
    }
  }, [])
  const setTerminalSplitLayout = useCallback((layout: TerminalSplitLayout) => {
    edited.current = true
    setLayout(layout)
    void saveTerminalSplitLayout(layout).catch(() => {
      Alert.alert(
        translate('session.terminalSplitLayout.saveFailedTitle', 'Layout could not be saved'),
        translate(
          'session.terminalSplitLayout.saveFailedMessage',
          'This layout applies for now. Choose it again to retry saving.'
        )
      )
    })
  }, [])
  return { terminalSplitLayout, setTerminalSplitLayout }
}
