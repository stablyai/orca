import { useEffect, useRef } from 'react'
import { BackHandler, Platform } from 'react-native'

// Android takes hardware Back. On iOS a claim disables this screen and its parent: the host document is often the only screen, so the swipe belongs to the parent and would pop that document to the server list.
export function useShellPageBack(args: {
  claimed: boolean
  isFocused: () => boolean
  // Return false for an undeliverable press so navigation can handle it.
  sendBack: () => boolean
  setOptions: (options: { gestureEnabled: boolean }) => void
  // The host document is often the only screen in its stack. The swipe then belongs to the parent and pops that document to the server list.
  setParentOptions?: (options: { gestureEnabled: boolean }) => void
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
    if (!claimed) {
      return
    }
    latest.current.setParentOptions?.({ gestureEnabled: false })
    return () => {
      latest.current.setParentOptions?.({ gestureEnabled: true })
    }
  }, [claimed])
}
