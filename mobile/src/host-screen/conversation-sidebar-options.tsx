import { Eye } from 'lucide-react-native'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { conversationCopy } from './conversation-copy'
import type { HostScreenController } from './use-host-screen-controller'

export function ConversationSidebarOptions({
  visible,
  controller,
  archived,
  onClose,
  onToggleArchive,
  onWorkspaces,
  onHiddenProjects
}: {
  visible: boolean
  controller: HostScreenController
  archived: boolean
  onClose: () => void
  onToggleArchive: () => void
  onWorkspaces: () => void
  onHiddenProjects?: () => void
}) {
  const copy = conversationCopy()
  const { hostId, actions, connState } = controller
  return (
    <ActionSheetModal
      visible={visible}
      title={copy.settings}
      onClose={onClose}
      actions={[
        { label: archived ? copy.back : copy.archived, onPress: onToggleArchive },
        ...(onHiddenProjects
          ? [
              {
                label: copy.hiddenProjects,
                icon: Eye,
                closeBeforePress: true,
                onPress: onHiddenProjects
              }
            ]
          : []),
        { label: copy.workspaces, onPress: onWorkspaces },
        {
          label: copy.accounts,
          onPress: () => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/accounts`)
        },
        {
          label: copy.tasks,
          onPress: () => actions.navigateFromHostList(`/h/${encodeURIComponent(hostId)}/tasks`)
        },
        {
          label: copy.newWorkspace,
          onPress: actions.openNewWorktreeModal,
          disabled: connState !== 'connected'
        }
      ]}
    />
  )
}
