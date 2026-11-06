import { Eye } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { conversationCopy } from './conversation-copy'

export function HiddenConversationProjectsSheet({
  visible,
  projects,
  supported,
  writing,
  connected,
  onClose,
  onRestore
}: {
  visible: boolean
  projects: Record<string, string> | undefined
  supported: boolean
  writing: boolean
  connected: boolean
  onClose: () => void
  onRestore: (key: string, label: string) => void
}) {
  const copy = conversationCopy()
  return (
    <ActionSheetModal
      visible={visible}
      title={copy.hiddenProjects}
      message={copy.keepFiles}
      onClose={onClose}
      actions={Object.entries(projects ?? {}).map(([key, label]) => ({
        label: `${copy.restoreProject}: ${label}`,
        icon: Eye,
        disabled: !connected || writing || !supported,
        onPress: () => onRestore(key, label)
      }))}
    />
  )
}
