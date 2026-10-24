import { Copy, FileText } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileTerminalFileTapSheet({
  controller
}: {
  controller: Pick<
    MobileSessionController,
    'pendingTerminalFileTap' | 'setPendingTerminalFileTap' | 'showToast'
  >
}) {
  const { pendingTerminalFileTap, setPendingTerminalFileTap, showToast } = controller
  const clipboard = useClipboardWriter()
  return (
    <ActionSheetModal
      visible={pendingTerminalFileTap != null}
      title={pendingTerminalFileTap?.title || 'File Link'}
      message={pendingTerminalFileTap?.displayPath}
      actions={[
        {
          label: 'Open File',
          icon: FileText,
          onPress: () => {
            const target = pendingTerminalFileTap
            setPendingTerminalFileTap(null)
            target?.onOpen()
          }
        },
        {
          label: 'Copy Path',
          icon: Copy,
          onPress: () => {
            const target = pendingTerminalFileTap
            setPendingTerminalFileTap(null)
            if (!target) {
              return
            }
            void clipboard
              .writeText(target.copyPath)
              .then(() => {
                triggerSuccess()
                showToast('Path copied')
              })
              .catch(() => {
                triggerError()
                showToast("Couldn't copy path", 1500)
              })
          }
        }
      ]}
      onClose={() => setPendingTerminalFileTap(null)}
    />
  )
}
