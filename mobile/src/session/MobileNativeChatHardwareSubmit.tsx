import { useCallback, useState, type ReactNode } from 'react'
import { useFocusEffect } from 'expo-router'
import { HardwareKeyboardCaptureView } from '@orca/expo-hardware-keyboard'

export function MobileNativeChatHardwareSubmit({
  children,
  enabled,
  onSubmit
}: {
  children: ReactNode
  enabled: boolean
  onSubmit: () => Promise<void>
}) {
  const [routeFocused, setRouteFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setRouteFocused(true)
      return () => setRouteFocused(false)
    }, [])
  )
  return (
    <HardwareKeyboardCaptureView
      mode="submit"
      enabled={enabled && routeFocused}
      onHardwareKey={({ nativeEvent }) => {
        if (enabled && routeFocused && nativeEvent.key === 'Enter' && !nativeEvent.repeat) {
          void onSubmit()
        }
      }}
    >
      {children}
    </HardwareKeyboardCaptureView>
  )
}
