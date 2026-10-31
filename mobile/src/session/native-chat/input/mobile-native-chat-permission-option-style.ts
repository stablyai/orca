import { Hand, FilePenLine, ShieldCheck, ShieldAlert, type LucideIcon } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import {
  AGENT_CHAT_PERMISSION_MODE_ICON_NAMES,
  isAgentChatPermissionMode
} from '../../../../../src/shared/agent-chat-permission-mode'

/** Full access reads in the warning colour wherever it is shown. */
export function permissionChoiceColor(value: string | undefined): string | undefined {
  return value === 'full-access' ? colors.statusAmber : undefined
}

/** Undefined for a mode a newer host states that this build has no icon for. */
export function permissionModeIcon(value: string): LucideIcon | undefined {
  if (!isAgentChatPermissionMode(value)) {
    return undefined
  }
  switch (AGENT_CHAT_PERMISSION_MODE_ICON_NAMES[value]) {
    case 'Hand':
      return Hand
    case 'FilePenLine':
      return FilePenLine
    case 'ShieldCheck':
      return ShieldCheck
    case 'ShieldAlert':
      return ShieldAlert
  }
}
