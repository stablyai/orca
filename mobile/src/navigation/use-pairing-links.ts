import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import * as Linking from 'expo-linking'
import { extractPairingCodeFromUrl } from '../pairing/pairing'
import { consumeInitialLaunchIntent } from './initial-launch-intent'
import { parseBotLinkTarget } from '../bots/bot-link-target'
import { publishBotLink } from '../bots/pending-bot-link'
import { loadHostCatalog } from '../host-catalog/host-store'
import { getNotificationNavigationTarget } from '../notifications/navigation/notification-routing'
import { useOpenNotificationRoute } from '../notifications/navigation/use-open-notification-route'
import {
  hostSessionLinkRouteData,
  parseHostSessionLink,
  type HostSessionLink
} from './host-session-link'

export function usePairingLinks(): void {
  const router = useRouter()
  const openNotificationRoute = useOpenNotificationRoute()
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
        return
      }
      const sessionLink = parseHostSessionLink(url)
      if (sessionLink) {
        router.dismissTo('/')
        void openHostSessionLink(sessionLink)
      }
    }

    async function openHostSessionLink(link: HostSessionLink) {
      const hosts = await loadHostCatalog().catch(() => null)
      if (disposed || !hosts) {
        return
      }
      const target = getNotificationNavigationTarget(hostSessionLinkRouteData(link, hosts), {
        credentialStatusByHostId: new Map(hosts.map((host) => [host.id, host.credentialStatus]))
      })
      // An unknown host stays on Home, as an unmatched notification does.
      if (target) {
        openNotificationRoute(target)
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
  }, [openNotificationRoute, router])
}
