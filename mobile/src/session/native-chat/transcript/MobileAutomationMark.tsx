import { Clock, Hourglass, Play, Webhook, Zap, type LucideIcon } from 'lucide-react-native'
import type { AutomationRowMark } from '../../../../../src/shared/automations/automation-chat-row'
import {
  MobileConnectorSourceIcon,
  MobileGoogleMark
} from '../../../bots/MobileConnectorSourceIcon'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'

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

/** An automation row's mark: the connector that starts it, else a plain mark. */
export function MobileAutomationMark({
  mark
}: {
  mark: AutomationRowMark
}): React.JSX.Element | null {
  const colors = useMobileColors()
  const Icon = PLAIN[mark]
  return Icon ? (
    <Icon size={14} color={colors.textMuted} strokeWidth={2} />
  ) : mark === 'google' ? (
    <MobileGoogleMark />
  ) : mark === 'github' || mark === 'slack' || mark === 'linear' ? (
    <MobileConnectorSourceIcon source={mark} />
  ) : null
}
