import { useEffect, useRef } from 'react'
import { BackHandler, Platform } from 'react-native'

// Android intercepts/posts hardware Back; iOS disables the stack swipe while claimed so it cannot pop the page (the shell's edge swipe sends Back instead). No live claim leaves navigation unchanged.
export function useShellPageBack(args: {
  claimed: boolean
  isFocused: () => boolean
  // Return false for an undeliverable press so navigation can handle it.
  sendBack: () => boolean
  setOptions: (options: { gestureEnabled: boolean }) => void
  // A nested stack's first screen is popped by its parent screen's swipe, so its claim must turn that one off too.
  isStackRoot: () => boolean
  setParentOptions: (options: { gestureEnabled: boolean }) => void
}): void {
  const { claimed } = args
  // Hold fresh caller callbacks without tearing down key registration on every render.
  const latest = useRef(args)
  // Update after commit rather than replayable render; declare first so registration effects see current callbacks.
  useEffect(() => {
    latest.current = args
  })

  useEffect(() => {
    if (!claimed || Platform.OS !== 'android') {
      return
    }
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => latest.current.isFocused() && latest.current.sendBack()
    )
    return () => subscription.remove()
  }, [claimed])

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return
    }
    latest.current.setOptions({ gestureEnabled: !claimed })
    if (!claimed || !latest.current.isStackRoot()) {
      return
    }
    latest.current.setParentOptions({ gestureEnabled: false })
    return () => latest.current.setParentOptions({ gestureEnabled: true })
  }, [claimed])
}
