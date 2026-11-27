import { ArrowRight, Copy, ExternalLink, Monitor, ShieldAlert } from 'lucide-react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { triggerError, triggerSuccess } from '../../platform/haptics/haptics'
import type { ActionSheetAction } from '../../components/sheets/ActionSheetModal'
import { phoneOpenableBrowserUrl } from '../link-open/phone-openable-browser-url'
import type { MobileBrowserViewMode } from '../screencast/browser-screencast-request-parameters'
import { isBlankBrowserUrl } from './browser-url'

/** The bottom bar's ⋯: the page's less frequent controls, and a certificate warning's unsafe way past. */
export function useMobileBrowserPageMenu({
  url,
  canGoForward,
  controlsDisabled,
  browserViewMode,
  selectBrowserViewMode,
  goForward,
  proceedUnsafe,
  onToast
}: {
  url: string
  canGoForward: boolean
  controlsDisabled: boolean
  browserViewMode: MobileBrowserViewMode
  selectBrowserViewMode: (mode: MobileBrowserViewMode) => void
  goForward: () => void
  proceedUnsafe: (() => void) | null
  onToast: (message: string, durationMs?: number) => void
}): ActionSheetAction[][] {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const blank = isBlankBrowserUrl(url)
  const externalUrl = blank ? null : phoneOpenableBrowserUrl(url)
  const page: ActionSheetAction[] = [
    ...(canGoForward
      ? [
          {
            id: 'forward',
            label: t('browser.paneView.forward', 'Forward'),
            icon: ArrowRight,
            disabled: controlsDisabled,
            onPress: goForward
          }
        ]
      : []),
    {
      id: 'desktopSite',
      label: t('browser.pageMenu.desktopSite', 'Desktop site'),
      icon: Monitor,
      checked: browserViewMode === 'web',
      disabled: controlsDisabled,
      onPress: () => selectBrowserViewMode(browserViewMode === 'web' ? 'mobile' : 'web')
    }
  ]
  const link: ActionSheetAction[] = [
    ...(blank
      ? []
      : [
          {
            id: 'copyLink',
            label: t('session.linkActionSheet.copyLink', 'Copy link'),
            icon: Copy,
            onPress: () => {
              void clipboard.writeText(url).then(
                () => {
                  triggerSuccess()
                  onToast(t('session.sheets.linkCopied', 'Link copied'))
                },
                () => {
                  triggerError()
                  onToast(t('session.sheets.copyLinkFailed', "Couldn't copy link"), 1500)
                }
              )
            }
          }
        ]),
    ...(externalUrl
      ? [
          {
            id: 'openInBrowser',
            label: t('session.linkActionSheet.openInBrowser', 'Open in system browser'),
            icon: ExternalLink,
            closeBeforePress: true,
            onPress: () => void openExternalLink(externalUrl)
          }
        ]
      : [])
  ]
  const unsafe: ActionSheetAction[] = proceedUnsafe
    ? [
        {
          id: 'proceedUnsafe',
          label: t('browser.loadFailure.proceedUnsafe', 'Proceed Anyway (Unsafe)'),
          icon: ShieldAlert,
          destructive: true,
          onPress: proceedUnsafe
        }
      ]
    : []
  return [page, link, unsafe].filter((group) => group.length > 0)
}
