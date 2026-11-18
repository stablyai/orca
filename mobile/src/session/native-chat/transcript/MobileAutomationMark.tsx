import { Clock, Hourglass, Play, Webhook, Zap, type LucideIcon } from 'lucide-react-native'
import { View } from 'react-native'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import {
  MobileConnectorSourceIcon,
  MobileGoogleMark
} from '../../../bots/MobileConnectorSourceIcon'
import { colors } from '../../../theme/mobile-theme'
import { styles as card } from './agent-messages/mobile-agent-message-card-styles'

// Connectors draw their own logo; the rest a plain mark.
const PLAIN: Record<AutomationRowMark, LucideIcon | null> = {
  github: null,
  slack: null,
  linear: null,
  google: null,
  schedule: Clock,
  webhook: Webhook,
  deadline: Hourglass,
  manual: Play,
  event: Zap
}

/** An automation row's icon slot: the connector that starts it, else a plain mark. */
export function MobileAutomationMark({ mark }: { mark: AutomationRowMark }): React.JSX.Element {
  const Icon = PLAIN[mark]
  return (
    <View pointerEvents="none" style={card.avatar}>
      {Icon ? (
        <Icon size={14} color={colors.textMuted} />
      ) : mark === 'google' ? (
        <MobileGoogleMark />
      ) : mark === 'github' || mark === 'slack' || mark === 'linear' ? (
        <MobileConnectorSourceIcon source={mark} />
      ) : null}
    </View>
  )
}
