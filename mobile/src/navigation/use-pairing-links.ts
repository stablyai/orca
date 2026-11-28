import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { extractPairingCodeFromUrl } from '../pairing/pairing'
import { consumeInitialLaunchIntent } from './initial-launch-intent'
import { parseBotLinkTarget } from '../bots/bot-link-target'
import { publishBotLink } from '../bots/pending-bot-link'

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
        return
      }
      const botLink = parseBotLinkTarget(url)
      if (botLink) {
        // Leave the unmatched orca://bot route for Home; the bot opens from there once a host claims it.
        router.dismissTo('/')
        publishBotLink(botLink)
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
