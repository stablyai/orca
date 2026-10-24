import { ChevronLeft, ChevronRight, Copy, RefreshCw } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError } from '../platform/haptics'
import type { MobileSessionTab } from './mobile-session-route-types'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'

type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
export type MobileBrowserNavigationMethod = 'browser.back' | 'browser.forward' | 'browser.reload'

/** Keeps browser-tab navigation actions out of the session route while preserving
 *  the target captured at the moment each drawer action is pressed. */
export function MobileBrowserTabActionSheet(props: {
  target: BrowserTab | null
  onClose: () => void
  onNavigate: (target: BrowserTab, method: MobileBrowserNavigationMethod) => void
  onCloseTab: (target: BrowserTab) => void
  onToast?: (message: string, durationMs?: number) => void
  /** Rendered after Close — receives the open tab's id so the session route's
   *  bulk-close builder can resolve the anchor itself. */
  bulkCloseActions?: (anchorTabId: string | undefined, dismiss: () => void) => ActionSheetAction[]
}): React.JSX.Element {
  const { target, onClose, onNavigate, onCloseTab, onToast, bulkCloseActions } = props
  const clipboard = useClipboardWriter()
  return (
    <ActionSheetModal
      visible={target != null}
      title={target ? getMobileSessionTabTitle(target) : 'Browser'}
      actions={[
        ...(target?.canGoBack
          ? [
              {
                label: 'Back',
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
                label: 'Forward',
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
          label: 'Reload',
          icon: RefreshCw,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onNavigate(current, 'browser.reload')
            }
          }
        },
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
        {
          label: 'Close',
          destructive: true,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onCloseTab(current)
            }
          }
        },
        ...(bulkCloseActions?.(target?.id, onClose) ?? [])
      ]}
      onClose={onClose}
    />
  )
}
