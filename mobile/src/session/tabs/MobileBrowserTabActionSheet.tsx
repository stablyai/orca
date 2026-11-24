import { Copy, ExternalLink, RotateCw, X } from 'lucide-react-native'
import type { MobileSessionTab } from './mobile-session-tabs'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { isBlankBrowserUrl } from '../../browser/pane-view/browser-url'
import { openExternalLink } from '../../platform/external-links/external-link'
import { phoneOpenableBrowserUrl } from '../../browser/link-open/phone-openable-browser-url'
import { mobileSessionTabMenuHeader } from './MobileSessionTabMark'

type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
export type MobileBrowserNavigationMethod = 'browser.back' | 'browser.forward' | 'browser.reload'
export type MobileBrowserNavigationOptions = { ignoreCache?: boolean }

/** What the page's own toolbar can't do: back, forward and reload stay on the toolbar. */
export function MobileBrowserTabActionSheet(props: {
  target: BrowserTab | null
  onClose: () => void
  onNavigate: (
    target: BrowserTab,
    method: MobileBrowserNavigationMethod,
    options?: MobileBrowserNavigationOptions
  ) => void
  onCloseTab: (target: BrowserTab) => void
  onCopyLink: (url: string) => void
  /** Older hosts drop ignoreCache and reload normally, so Hard reload stays hidden there. */
  hardReloadSupported: boolean
  /** The tab's profile name, read-only; null when the host doesn't say. */
  profileLabel: string | null
  /** Rendered after Close — receives the open tab's id so the session route's
   *  bulk-close builder can resolve the anchor itself. */
  bulkCloseActions?: (anchorTabId: string | undefined) => ActionSheetAction[]
}): React.JSX.Element {
  const t = useMobileTranslation()
  const {
    target,
    onClose,
    onNavigate,
    onCloseTab,
    onCopyLink,
    hardReloadSupported,
    profileLabel,
    bulkCloseActions
  } = props
  const url = target && !isBlankBrowserUrl(target.url) ? target.url : null
  const externalUrl = url ? phoneOpenableBrowserUrl(url) : null
  const header = mobileSessionTabMenuHeader(target, [])
  return (
    <ActionSheetModal
      visible={target != null}
      {...header}
      // The profile reads under the title ("Browser · Work"); it can't be changed from here.
      message={
        header.message && profileLabel !== null
          ? `${header.message} · ${profileLabel}`
          : header.message
      }
      groupDestructive
      title={
        target
          ? getMobileSessionTabTitle(target)
          : t('session.browserTabActionSheet.title', 'Browser')
      }
      actions={[
        ...(hardReloadSupported
          ? [
              {
                id: 'hardReload',
                label: t('session.browserTabActionSheet.hardReload', 'Hard reload'),
                icon: RotateCw,
                onPress: () => {
                  const current = target
                  onClose()
                  if (current) {
                    onNavigate(current, 'browser.reload', { ignoreCache: true })
                  }
                }
              }
            ]
          : []),
        ...(url
          ? [
              {
                id: 'copyLink',
                label: t('session.linkActionSheet.copyLink', 'Copy link'),
                icon: Copy,
                onPress: () => {
                  onClose()
                  onCopyLink(url)
                }
              }
            ]
          : []),
        ...(externalUrl
          ? [
              {
                id: 'openInBrowser',
                label: t('session.linkActionSheet.openInBrowser', 'Open in system browser'),
                icon: ExternalLink,
                closeBeforePress: true,
                onPress: () => openExternalLink(externalUrl)
              }
            ]
          : []),
        {
          id: 'close',
          label: t('session.tabMenu.closeTab', 'Close tab'),
          icon: X,
          destructive: true,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onCloseTab(current)
            }
          }
        },
        ...(bulkCloseActions?.(target?.id) ?? [])
      ]}
      onClose={onClose}
    />
  )
}
