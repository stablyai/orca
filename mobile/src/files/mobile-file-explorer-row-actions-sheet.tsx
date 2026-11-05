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
  const copyAction = (id: string, label: string, text: string): ActionSheetAction => ({
    id,
    label,
    icon: Copy,
    onPress: () => void clipboard.writeText(text).then(triggerSuccess, triggerError)
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
