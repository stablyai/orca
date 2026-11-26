import { FileText, RefreshCw } from 'lucide-react-native'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { triggerError } from '../platform/haptics/haptics'
import { ActionSheetModal, type ActionSheetAction } from '../components/sheets/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileSessionTab } from './tabs/mobile-session-tabs'
import { mobileSessionTabMenuHeader } from './tabs/MobileSessionTabMark'

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
  const t = useMobileTranslation()
  const { target, onClose, onRefresh, onToast, closeWithBulkActions } = props
  const clipboard = useClipboardWriter()
  return (
    <ActionSheetModal
      visible={target != null}
      {...mobileSessionTabMenuHeader(target, [])}
      groupDestructive
      title={target?.title || t('session.sheets.file', 'File')}
      actions={[
        {
          id: 'refresh',
          label: t('common.refresh', 'Refresh'),
          icon: RefreshCw,
          onPress: () => {
            const current = target
            onClose()
            if (current) {
              onRefresh(current)
            }
          }
        },
        ...(target?.relativePath
          ? [
              {
                id: 'copyPath',
                label: t('session.sheets.copyPath', 'Copy Path'),
                icon: FileText,
                onPress: () => {
                  const current = target
                  onClose()
                  if (current?.relativePath) {
                    void clipboard
                      .writeText(current.relativePath)
                      .then(() =>
                        onToast(t('session.useMarkdownActions.pathCopied', 'Path copied'))
                      )
                      .catch(() => {
                        triggerError()
                        onToast(
                          t('session.useMarkdownActions.copyPathFailed', "Couldn't copy path"),
                          1500
                        )
                      })
                  }
                }
              }
            ]
          : []),
        ...closeWithBulkActions(target, onClose)
      ]}
      onClose={onClose}
    />
  )
}
