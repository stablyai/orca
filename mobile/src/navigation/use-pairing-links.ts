import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { extractPairingCodeFromUrl } from '../transport/pairing'
import { consumeInitialLaunchIntent } from './initial-launch-intent'

export function usePairingLinks(): void {
  const router = useRouter()
  useEffect(() => {
    let disposed = false
    function handleUrl(url: string) {
      if (disposed) {
        return
      }
      const code = extractPairingCodeFromUrl(url)
      if (code) {
        // Replace the camera's unmatched pair route so Back cannot reveal the router error.
        router.replace({ pathname: '/pair-confirm', params: { code } })
      }
    }

    const intent = consumeInitialLaunchIntent('pairing-link')
    if (intent) {
      void Linking.getInitialURL()
        .then((url) => {
          if (url && !intent.discarded) {
            handleUrl(url)
          }
        })
        .catch(() => {})
    }
    const sub = Linking.addEventListener('url', ({ url }) => handleUrl(url))
    return () => {
      disposed = true
      sub.remove()
    }
  }, [router])
}
