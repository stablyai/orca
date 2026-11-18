import { AtSign, Package, Paperclip, Terminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../../components/sheets/ActionSheetModal'
import { translate } from '../../../../i18n/mobile-i18n'

// Rows below the Add context sheet's photo strip; the sheet dismisses itself before each runs.
export function mobileNativeChatAttachActions(args: {
  onFiles: (() => void) | undefined
  structured: boolean
  onWorkspaceFile: () => void
  onSkills: () => void
  onCommands: () => void
  skillCount: number
}): ActionSheetAction[] {
  const actions: ActionSheetAction[] = []
  if (args.onFiles) {
    actions.push({
      id: 'files',
      label: translate('session.nativeChatAttachActions.addFiles', 'Add files'),
      hint: translate('session.nativeChatAttachActions.fileTypes', 'PDF, text, code…'),
      icon: Paperclip,
      onPress: args.onFiles
    })
  }
  if (!args.structured) {
    return actions
  }
  actions.push(
    {
      id: 'workspaceFile',
      label: translate('session.nativeChatAttachActions.workspaceFile', 'Workspace file'),
      icon: AtSign,
      onPress: args.onWorkspaceFile
    },
    {
      id: 'skills',
      label: translate('session.nativeChatAttachActions.skills', 'Skills'),
      ...(args.skillCount > 0
        ? {
            hint: translate(
              'session.nativeChatAttachActions.availableSkills',
              '{{count}} available',
              {
                count: args.skillCount
              }
            )
          }
        : {}),
      icon: Package,
      onPress: args.onSkills
    },
    {
      id: 'commands',
      label: translate('session.nativeChatAttachActions.commands', 'Commands'),
      icon: Terminal,
      onPress: args.onCommands
    }
  )
  return actions
}
