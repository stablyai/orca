import { AtSign, Goal, Image, Package, Paperclip, PencilRuler, Terminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../../../../components/sheets/ActionSheetModal'
import { translate } from '../../../../i18n/mobile-i18n'

// Dismiss the sheet before opening pickers because iOS cannot present them over its Modal.
export function mobileNativeChatAttachActions(args: {
  onPhotos: (() => void) | undefined
  onFiles: (() => void) | undefined
  onWorkspaceFile: () => void
  onSkills: () => void
  onCommands: () => void
  skillCount: number
  /** Turns plan mode on; absent while it is on or where the chat has none. */
  onPlan?: (() => void) | undefined
  /** Enters goal mode; absent while it is on or where the chat has none. */
  onGoal?: (() => void) | undefined
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
  actions.push(
    {
      id: 'workspaceFile',
      label: translate('session.nativeChatAttachActions.workspaceFile', 'Workspace file'),
      icon: AtSign,
      closeBeforePress: true,
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
      closeBeforePress: true,
      onPress: args.onSkills
    },
    {
      id: 'commands',
      label: translate('session.nativeChatAttachActions.commands', 'Commands'),
      icon: Terminal,
      closeBeforePress: true,
      onPress: args.onCommands
    }
  )
  if (args.onPlan) {
    actions.push({
      id: 'plan',
      label: translate('session.nativeChatAttachActions.plan', 'Plan first'),
      icon: PencilRuler,
      closeBeforePress: true,
      onPress: args.onPlan
    })
  }
  if (args.onGoal) {
    actions.push({
      id: 'goal',
      label: translate('session.nativeChatAttachActions.goal', 'Set a goal'),
      icon: Goal,
      closeBeforePress: true,
      onPress: args.onGoal
    })
  }
  return actions
}
