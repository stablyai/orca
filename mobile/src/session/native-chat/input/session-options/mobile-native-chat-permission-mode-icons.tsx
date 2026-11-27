import { FilePenLine, Hand, ShieldAlert, ShieldCheck, type LucideIcon } from 'lucide-react-native'
import {
  AGENT_CHAT_PERMISSION_MODE_ICON_NAMES,
  isAgentChatPermissionMode
} from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import type { MobilePalette } from '../../../../theme/mobile-theme'

export function permissionChoiceColor(
  colors: MobilePalette,
  value: string | undefined
): string | undefined {
  return value === 'full-access' ? colors.statusAmber : undefined
}

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

export function permissionChoiceLeading(
  colors: MobilePalette,
  value: string
): React.JSX.Element | null {
  const Icon = permissionModeIcon(value)
  return Icon ? (
    <Icon
      size={18}
      color={permissionChoiceColor(colors, value) ?? colors.textSecondary}
      strokeWidth={2.2}
    />
  ) : null
}
