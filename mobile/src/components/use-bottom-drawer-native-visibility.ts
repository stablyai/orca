import { useCallback, useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

export function useBottomDrawerNativeVisibility(visible: boolean, onHidden: () => void) {
  const [nativeVisible, setNativeVisible] = useState(true)
  const nativeHideRequestedRef = useRef(false)
  const hiddenReportedRef = useRef(false)

  const reportHidden = useCallback(() => {
    if (hiddenReportedRef.current) {
      return
    }
    hiddenReportedRef.current = true
    onHidden()
  }, [onHidden])

  const hideNativeModal = useCallback(() => {
    if (nativeHideRequestedRef.current) {
      return
    }
    nativeHideRequestedRef.current = true
    setNativeVisible(false)
    if (Platform.OS !== 'ios') {
      reportHidden()
    }
  }, [reportHidden])

  useEffect(() => {
    if (!visible) {
      return
    }
    nativeHideRequestedRef.current = false
    hiddenReportedRef.current = false
    setNativeVisible(true)
  }, [visible])

  return { nativeVisible, hideNativeModal, reportHidden }
}
