import { useEffect } from 'react'
import { AppState } from 'react-native'
import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import { consumeInitialLaunchIntent } from '../navigation/initial-launch-intent'
import { isIncomingShareUrl } from './incoming-share'
import { receiveIncomingShare } from './incoming-share-intake'

// Shares arrive as a marker link while running; a cold launch, or one delivered before React listened
// (relaunch into a restored task), only shows up in the native module, so also look on mount and foreground.
export function useIncomingShareIntake(): void {
  const router = useRouter()
  useEffect(() => {
    let disposed = false
    function receive(): void {
      void receiveIncomingShare().then((received) => {
        if (received && !disposed) {
          // Home is the destination picker.
          router.dismissTo('/')
        }
      })
    }
    if (consumeInitialLaunchIntent('share')) {
      receive()
    }
    const linkSub = Linking.addEventListener('url', ({ url }) => {
      if (isIncomingShareUrl(url)) {
        receive()
      }
    })
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        receive()
      }
    })
    return () => {
      disposed = true
      linkSub.remove()
      appStateSub.remove()
    }
  }, [router])
}
