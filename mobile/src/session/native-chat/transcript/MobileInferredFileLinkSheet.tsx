import { useState } from 'react'
import { FileText } from 'lucide-react-native'
import { ActionSheetModal } from '../../../components/ActionSheetModal'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'

export function MobileInferredFileLinkSheet({
  pathText,
  onOpenFile,
  onClose
}: {
  pathText: string
  onOpenFile: (pathText: string) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  const [visible, setVisible] = useState(true)
  return (
    <ActionSheetModal
      visible={visible}
      title={pathText}
      message={t(
        'chat.fileLink.workspaceResolution',
        "Filename resolved relative to this chat's workspace."
      )}
      actions={[
        {
          id: 'openFile',
          label: t('chat.fileLink.open', 'Open file'),
          icon: FileText,
          closeBeforePress: true,
          onPress: () => onOpenFile(pathText)
        }
      ]}
      onClose={() => setVisible(false)}
      onAfterClose={onClose}
    />
  )
}
