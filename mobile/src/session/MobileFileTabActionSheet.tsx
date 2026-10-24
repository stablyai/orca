import { FileText, RefreshCw } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError } from '../platform/haptics'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import type { MobileSessionTab } from './mobile-session-route-types'

type FileTab = Extract<MobileSessionTab, { type: 'file' }>

export function MobileFileTabActionSheet(props: {
  target: FileTab | null
  onClose: () => void
  onRefresh: (target: FileTab) => void
  onToast: (message: string, durationMs?: number) => void
  closeWithBulkActions: (
    target: MobileSessionTab | null,
    dismiss: () => void
  ) => ActionSheetAction[]
}): React.JSX.Element {
  const { target, onClose, onRefresh, onToast, closeWithBulkActions } = props
  const clipboard = useClipboardWriter()
  return (
    <ActionSheetModal
      visible={target != null}
      title={target?.title || 'File'}
      actions={[
        {
          label: 'Refresh',
          icon: RefreshCw,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onRefresh(current)
            }
          }
        },
        {
          label: 'Copy Path',
          icon: FileText,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              void clipboard
                .writeText(current.filePath || current.relativePath)
                .then(() => onToast('Path copied'))
                .catch(() => {
                  triggerError()
                  onToast("Couldn't copy path", 1500)
                })
            }
          }
        },
        ...closeWithBulkActions(target, onClose)
      ]}
      onClose={onClose}
    />
  )
}
