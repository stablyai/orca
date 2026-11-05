import { useState } from 'react'
import { Copy } from 'lucide-react-native'
import { ActionSheetModal, type ActionSheetAction } from '../components/ActionSheetModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { TreeNode } from './file-tree'

/** A long-pressed explorer row's copy actions, named like the desktop File Explorer menu. */
export function MobileFileExplorerRowActionsSheet({
  node,
  onClose
}: {
  node: TreeNode | null
  onClose: () => void
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  // Held with its row so a refusal shown for one file never labels the next.
  const [failure, setFailure] = useState<{ node: TreeNode; actionId: string } | null>(null)
  const failedActionId = failure?.node === node ? failure.actionId : null

  // Close only once the text landed; Alert is a no-op in the page, so a refusal stays in the sheet.
  const copyAction = (id: string, label: string, text: string): ActionSheetAction => ({
    id,
    label,
    icon: Copy,
    hint:
      failedActionId === id
        ? t('files.fileExplorerRowActions.copyFailed', "Couldn't copy")
        : undefined,
    skipAutoClose: true,
    onPress: () => {
      const target = node
      void clipboard.writeText(text).then(
        () => {
          triggerSuccess()
          onClose()
        },
        () => {
          triggerError()
          setFailure(target ? { node: target, actionId: id } : null)
        }
      )
    }
  })

  return (
    <ActionSheetModal
      visible={node != null}
      title={node?.name}
      actions={
        node
          ? [
              copyAction(
                'copyName',
                t('files.fileExplorerRowActions.copyName', 'Copy Name'),
                node.name
              ),
              copyAction(
                'copyRelativePath',
                t('files.fileExplorerRowActions.copyRelativePath', 'Copy Relative Path'),
                node.relativePath
              )
            ]
          : []
      }
      onClose={onClose}
    />
  )
}
