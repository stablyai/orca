import { Copy, Globe } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobileSessionController } from './use-mobile-session-controller'

export type PendingTerminalUrlTap = {
  title: string
  url: string
  onOpen: () => void
}

export function displayTitleFromTerminalUrl(url: string): string {
  try {
    new URL(url)
    const authority = /^[a-z][a-z\d+.-]*:\/\/(?:[^/?#]*@)?([^/?#]+)/i.exec(url)
    if (authority?.[1]) {
      return authority[1]
    }
  } catch {
    // Non-standard URLs fall back to the generic sheet heading.
  }
  return 'URL Link'
}

export function MobileTerminalUrlTapSheet({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'pendingTerminalUrlTap' | 'setPendingTerminalUrlTap' | 'showToast'
  >
}) {
  const { pendingTerminalUrlTap, setPendingTerminalUrlTap, showToast } = controller
  const clipboard = useClipboardWriter()
  return (
    <ActionSheetModal
      visible={pendingTerminalUrlTap != null}
      title={pendingTerminalUrlTap?.title || 'URL Link'}
      message={pendingTerminalUrlTap?.url}
      actions={[
        {
          label: 'Open URL',
          icon: Globe,
          onPress: () => {
            const target = pendingTerminalUrlTap
            setPendingTerminalUrlTap(null)
            target?.onOpen()
          }
        },
        {
          label: 'Copy URL',
          icon: Copy,
          onPress: () => {
            const target = pendingTerminalUrlTap
            setPendingTerminalUrlTap(null)
            if (!target) {
              return
            }
            void clipboard
              .writeText(target.url)
              .then(() => {
                triggerSuccess()
                showToast('URL copied')
              })
              .catch(() => {
                triggerError()
                showToast("Couldn't copy URL", 1500)
              })
          }
        }
      ]}
      onClose={() => setPendingTerminalUrlTap(null)}
    />
  )
}
