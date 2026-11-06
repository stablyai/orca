import { EyeOff, Folder } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import type { HostScreenController } from './use-host-screen-controller'
import type { ConversationProject } from './project-conversations'
import { conversationCopy } from './conversation-copy'

export function ConversationProjectActionsSheet({
  project,
  onClose,
  onWorkspaces,
  onHide
}: {
  project: ConversationProject | null
  controller: HostScreenController
  onClose: () => void
  onWorkspaces: () => void
  onHide?: () => void
}) {
  const copy = conversationCopy()
  return (
    <ActionSheetModal
      visible={project !== null}
      title={project?.title}
      onClose={onClose}
      actions={[
        { label: copy.workspaces, icon: Folder, onPress: onWorkspaces },
        {
          label: copy.hideProject,
          icon: EyeOff,
          hint: copy.keepFiles,
          disabled: !onHide,
          onPress: () => onHide?.()
        }
      ]}
    />
  )
}
