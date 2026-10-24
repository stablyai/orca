import { ChevronLeft, ChevronRight, Copy, FileText, RefreshCw } from 'lucide-react-native'
import { fileUriToFilesystemPath } from '../../../src/shared/file-uri-path'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError } from '../platform/haptics'
import type { MobileSessionTab } from './mobile-session-route-types'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { getMobileSessionTabTitle } from './mobile-terminal-tab-agent'

type BrowserTab = Extract<MobileSessionTab, { type: 'browser' }>
export type MobileBrowserNavigationMethod = 'browser.back' | 'browser.forward' | 'browser.reload'

function resolveBrowserTabCopyTarget(
  rawUrl: string | undefined
): { kind: 'path' | 'url'; value: string } | null {
  const trimmed = rawUrl?.trim() ?? ''
  if (!trimmed) {
    return null
  }
  if (trimmed.toLowerCase().startsWith('file:')) {
    try {
      const filePath = fileUriToFilesystemPath(new URL(trimmed))
      if (filePath) {
        return { kind: 'path', value: filePath }
      }
    } catch {
      // Fall back to copying the raw URL string if the file URI cannot be parsed.
    }
  }
  return { kind: 'url', value: trimmed }
}

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
  const copyTarget = resolveBrowserTabCopyTarget(target?.url)
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
        ...(copyTarget
          ? [
              {
                label: copyTarget.kind === 'path' ? 'Copy Path' : 'Copy URL',
                icon: copyTarget.kind === 'path' ? FileText : Copy,
                onPress: () => {
                  const currentCopy = copyTarget
                  onClose()
                  void clipboard
                    .writeText(currentCopy.value)
                    .then(() =>
                      onToast?.(currentCopy.kind === 'path' ? 'Path copied' : 'URL copied')
                    )
                    .catch(() => {
                      triggerError()
                      onToast?.(
                        currentCopy.kind === 'path' ? "Couldn't copy path" : "Couldn't copy URL",
                        1500
                      )
                    })
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
