import { Laptop } from '../../components/icons/app-icons'
import { MobileStateView } from '../../components/feedback/MobileStateView'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { openExternalLink } from '../../platform/external-links/external-link'
import type { RuntimeMobileSessionBrowserClientHost } from '../../../../src/shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import { phoneOpenableBrowserUrl } from '../link-open/phone-openable-browser-url'

/** A page drawn in a paired desktop's own browser, which the server can't stream to this phone. */
export function MobileBrowserClientHostState({
  clientHost,
  url,
  bottomInset
}: {
  clientHost: RuntimeMobileSessionBrowserClientHost
  url: string
  bottomInset: number
}) {
  const t = useMobileTranslation()
  const externalUrl = phoneOpenableBrowserUrl(url)
  const device = clientHost.deviceName
  const title = clientHost.offline
    ? device
      ? t('browser.clientHost.offlineNamed', '{{device}} is offline', { device })
      : t('browser.clientHost.offline', 'The computer showing this page is offline')
    : device
      ? t('browser.clientHost.openOnNamed', 'Open on {{device}}', { device })
      : t('browser.clientHost.openOn', 'Open on another computer')
  return (
    <MobileStateView
      icon={Laptop}
      title={title}
      message={externalUrl ?? url}
      action={
        externalUrl
          ? {
              label: t('session.linkActionSheet.openInBrowser', 'Open in system browser'),
              onPress: () => openExternalLink(externalUrl)
            }
          : null
      }
      bottomInset={bottomInset}
    />
  )
}
