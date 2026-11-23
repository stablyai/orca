import {
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  RefreshCw,
  RotateCw,
  UserRound
} from 'lucide-react-native'
import { useClipboardWriter } from '../../platform/clipboard'
import { triggerError } from '../../platform/haptics'
import type { MobileSessionTab } from './mobile-session-tabs'
import { ActionSheetModal, type ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { isBlankBrowserUrl } from '../../browser/pane-view/browser-url'
import { canOpenExternalLink, openExternalLink } from '../../platform/external-links/external-link'
import { resolveRemoteFailureExternalUrl } from '../../../../src/shared/browser/navigation/browser-url'

type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
export type MobileBrowserNavigationMethod = 'browser.back' | 'browser.forward' | 'browser.reload'
export type MobileBrowserNavigationOptions = { ignoreCache?: boolean }

/** As desktop's streamed pane: only a public URL, since a local one names the host, not the phone. */
function phoneOpenableBrowserUrl(url: string): string | null {
  const external = resolveRemoteFailureExternalUrl(url)
  return external && canOpenExternalLink(external) ? external : null
}

export function MobileBrowserTabActionSheet(props: {
  target: BrowserTab | null
  onClose: () => void
  onNavigate: (
    target: BrowserTab,
    method: MobileBrowserNavigationMethod,
    options?: MobileBrowserNavigationOptions
  ) => void
  onCloseTab: (target: BrowserTab) => void
  onToast?: (message: string, durationMs?: number) => void
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
    onToast,
    onCopyLink,
    hardReloadSupported,
    profileLabel,
    bulkCloseActions
  } = props
  const clipboard = useClipboardWriter()
  const url = target && !isBlankBrowserUrl(target.url) ? target.url : null
  const externalUrl = url ? phoneOpenableBrowserUrl(url) : null
  return (
    <ActionSheetModal
      visible={target != null}
      title={
        target
          ? getMobileSessionTabTitle(target)
          : t('session.browserTabActionSheet.title', 'Browser')
      }
      actions={[
        ...(target?.canGoBack
          ? [
              {
                id: 'back',
                label: t('common.back', 'Back'),
                icon: ChevronLeft,
                onPress: () => {
                  const current = target
                  onClose()
                  if (current) {
                    onNavigate(current, 'browser.back')
                  }
                }
              }
            ]
          : []),
        ...(target?.canGoForward
          ? [
              {
                id: 'forward',
                label: t('session.browserTabActionSheet.forward', 'Forward'),
                icon: ChevronRight,
                onPress: () => {
                  const current = target
                  onClose()
                  if (current) {
                    onNavigate(current, 'browser.forward')
                  }
                }
              }
            ]
          : []),
        {
          id: 'reload',
          label: t('session.browserTabActionSheet.reload', 'Reload'),
          icon: RefreshCw,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onNavigate(current, 'browser.reload')
            }
          }
        },
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
        ...(target?.url
          ? [
              {
                label: 'Copy URL',
                icon: Copy,
                onPress: () => {
                  const current = target
                  onClose()
                  if (current?.url) {
                    void clipboard
                      .writeText(current.url)
                      .then(() => onToast?.('URL copied'))
                      .catch(() => {
                        triggerError()
                        onToast?.("Couldn't copy URL", 1500)
                      })
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
        ...(profileLabel !== null
          ? [
              {
                id: 'profile',
                label: t('session.browserProfile.title', 'Profile'),
                icon: UserRound,
                status: profileLabel,
                disabled: true,
                onPress: () => {}
              }
            ]
          : []),
        {
          id: 'close',
          label: t('common.close', 'Close'),
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
