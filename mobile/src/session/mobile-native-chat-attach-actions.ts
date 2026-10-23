import { AtSign, Image, Package, Paperclip, Terminal } from 'lucide-react-native'
import type { ActionSheetAction } from '../components/ActionSheetModal'

/** The composer's + sheet: every way to add to the message, then the session's skills and
 *  commands. Each runs once the sheet is gone, since iOS cannot present a picker over it. */
export function mobileNativeChatAttachActions(args: {
  onPhotos: (() => void) | undefined
  /** Absent where the host cannot take a file from a phone. */
  onFiles: (() => void) | undefined
  onWorkspaceFile: () => void
  onSkills: () => void
  onCommands: () => void
  skillCount: number
}): ActionSheetAction[] {
  const actions: ActionSheetAction[] = []
  if (args.onPhotos) {
    actions.push({ label: 'Photos', icon: Image, closeBeforePress: true, onPress: args.onPhotos })
  }
  if (args.onFiles) {
    actions.push({
      label: 'Files',
      hint: 'PDF, text, code…',
      icon: Paperclip,
      closeBeforePress: true,
      onPress: args.onFiles
    })
  }
  actions.push(
    {
      label: 'Workspace file',
      icon: AtSign,
      closeBeforePress: true,
      onPress: args.onWorkspaceFile
    },
    {
      label: 'Skills',
      ...(args.skillCount > 0 ? { hint: `${args.skillCount} available` } : {}),
      icon: Package,
      closeBeforePress: true,
      onPress: args.onSkills
    },
    { label: 'Commands', icon: Terminal, closeBeforePress: true, onPress: args.onCommands }
  )
  return actions
}
