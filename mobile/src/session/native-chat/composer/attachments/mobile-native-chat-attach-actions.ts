import { AtSign, Image, Package, Paperclip, Terminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../../components/sheets/ActionSheetModal'
import { translate } from '../../../../i18n/mobile-i18n'

// Dismiss the sheet before opening pickers because iOS cannot present them over its Modal.
// A terminal's + passes only photos and files; a structured chat adds the rest.
export function mobileNativeChatAttachActions(args: {
  onPhotos: (() => void) | undefined
  onFiles: (() => void) | undefined
  chat?: {
    onWorkspaceFile: () => void
    onSkills: () => void
    onCommands: () => void
    skillCount: number
  }
}): ActionSheetAction[] {
  const actions: ActionSheetAction[] = []
  if (args.onPhotos) {
    actions.push({
      id: 'photos',
      label: translate('session.nativeChatAttachActions.photos', 'Photos'),
      icon: Image,
      closeBeforePress: true,
      onPress: args.onPhotos
    })
  }
  if (args.onFiles) {
    actions.push({
      id: 'files',
      label: translate('session.nativeChatAttachActions.files', 'Files'),
      hint: translate('session.nativeChatAttachActions.fileTypes', 'PDF, text, code…'),
      icon: Paperclip,
      closeBeforePress: true,
      onPress: args.onFiles
    })
  }
  const chat = args.chat
  if (!chat) {
    return actions
  }
  actions.push(
    {
      id: 'workspaceFile',
      label: translate('session.nativeChatAttachActions.workspaceFile', 'Workspace file'),
      icon: AtSign,
      closeBeforePress: true,
      onPress: chat.onWorkspaceFile
    },
    {
      id: 'skills',
      label: translate('session.nativeChatAttachActions.skills', 'Skills'),
      ...(chat.skillCount > 0
        ? {
            hint: translate(
              'session.nativeChatAttachActions.availableSkills',
              '{{count}} available',
              {
                count: chat.skillCount
              }
            )
          }
        : {}),
      icon: Package,
      closeBeforePress: true,
      onPress: chat.onSkills
    },
    {
      id: 'commands',
      label: translate('session.nativeChatAttachActions.commands', 'Commands'),
      icon: Terminal,
      closeBeforePress: true,
      onPress: chat.onCommands
    }
  )
  return actions
}
