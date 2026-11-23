import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics/haptics'
import { MobileBrowserTabActionSheet } from './tabs/MobileBrowserTabActionSheet'
import type { MobileSessionController } from './use-mobile-session-controller'

/** The browser tab's long-press sheet, wired to the session. */
export function MobileSessionBrowserTabSheet({
  controller,
  profileLabel
}: {
  controller: MobileSessionController
  profileLabel: string | null
}): React.JSX.Element {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const {
    browserActionTarget,
    setBrowserActionTarget,
    handleBrowserNavigationCommand,
    handleCloseSessionTab,
    bulkCloseActions,
    browserHostSupport,
    showToast
  } = controller
  return (
    <MobileBrowserTabActionSheet
      target={browserActionTarget}
      onClose={() => setBrowserActionTarget(null)}
      onNavigate={handleBrowserNavigationCommand}
      onCloseTab={handleCloseSessionTab}
      onCopyLink={(url) => {
        void clipboard.writeText(url).then(
          () => {
            triggerSuccess()
            showToast(t('session.sheets.linkCopied', 'Link copied'))
          },
          () => {
            triggerError()
            showToast(t('session.sheets.copyLinkFailed', "Couldn't copy link"), 1500)
          }
        )
      }}
      hardReloadSupported={browserHostSupport.hardReload}
      profileLabel={profileLabel}
      bulkCloseActions={bulkCloseActions}
    />
  )
}
