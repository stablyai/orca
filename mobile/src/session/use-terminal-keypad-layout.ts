import { useCallback, useEffect, useState } from 'react'

import {
  loadTerminalKeypadLayout,
  saveTerminalKeypadLayout,
  type TerminalKeypadLayout
} from '../storage/preferences'

export function useTerminalKeypadLayout(dismissSoftwareKeyboard: () => void): {
  keypadLayout: TerminalKeypadLayout
  handleKeypadLayoutChange: (layout: TerminalKeypadLayout) => void
} {
  const [keypadLayout, setKeypadLayout] = useState<TerminalKeypadLayout>('shortcuts')

  useEffect(() => {
    let active = true
    void loadTerminalKeypadLayout().then((layout) => {
      if (active) {
        setKeypadLayout(layout)
      }
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    void saveTerminalKeypadLayout(keypadLayout)
  }, [keypadLayout])

  const handleKeypadLayoutChange = useCallback(
    (layout: TerminalKeypadLayout) => {
      if (layout === 'keyboard') {
        dismissSoftwareKeyboard()
      }
      setKeypadLayout(layout)
    },
    [dismissSoftwareKeyboard]
  )

  return { keypadLayout, handleKeypadLayoutChange }
}
