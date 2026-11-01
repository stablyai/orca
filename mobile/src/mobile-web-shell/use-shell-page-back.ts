import { useEffect, useRef } from 'react'
import { BackHandler, Platform } from 'react-native'

type GestureOptions = { setOptions: (options: { gestureEnabled: boolean }) => void }

// Several shells can sit under one parent screen; its swipe comes back only when the last claim ends.
const parentClaims = new WeakMap<GestureOptions, number>()

// Android intercepts/posts hardware Back; iOS disables the stack swipe while claimed so it cannot pop the page (the shell's edge swipe sends Back instead). No live claim leaves navigation unchanged.
export function useShellPageBack(args: {
  claimed: boolean
  isFocused: () => boolean
  // Return false for an undeliverable press so navigation can handle it.
  sendBack: () => boolean
  setOptions: (options: { gestureEnabled: boolean }) => void
  // A nested stack's only screen is popped by its parent screen's swipe, so a claim turns that one off too.
  // Harmless while a screen sits above: the nested stack's own swipe handles it.
  parent: GestureOptions | undefined
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
    const parent = latest.current.parent
    if (!claimed || !parent) {
      return
    }
    parentClaims.set(parent, (parentClaims.get(parent) ?? 0) + 1)
    parent.setOptions({ gestureEnabled: false })
    return () => {
      const left = (parentClaims.get(parent) ?? 1) - 1
      parentClaims.set(parent, left)
      if (left === 0) {
        parent.setOptions({ gestureEnabled: true })
      }
    }
  }, [claimed])
}
