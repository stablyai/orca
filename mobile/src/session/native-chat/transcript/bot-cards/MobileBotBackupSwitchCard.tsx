import { ArrowLeftRight, RotateCcw } from 'lucide-react-native'
import { tuiAgentDisplayName } from '../../../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import { formatUsageLimitResetClock } from '../../../../../../src/shared/agent-session/failures/agent-session-usage-limit'
import type { NativeChatBotCardValues } from '../../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors } from '../../../../theme/mobile-theme'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../messages/MobileNativeChatEventRow'

function modelDisplay(agent: string, model?: string): string {
  const agentName = tuiAgentDisplayName(agent) ?? agent
  return model ? `${agentName} · ${model}` : agentName
}

export function MobileBotBackupSwitchCard({
  switched,
  timestamp,
  fontScale
}: {
  switched: NativeChatBotCardValues['botBackupModelSwitch']
  timestamp: number | null
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const targetLabel = modelDisplay(switched.toAgent, switched.toModel)
  const fromLabel = modelDisplay(switched.fromAgent, switched.fromModel)
  const toPrimary = switched.direction === 'to-primary'
  const reset =
    !toPrimary && switched.resetsAt !== undefined
      ? formatUsageLimitResetClock(switched.resetsAt)
      : null
  const lead = toPrimary
    ? t('bots.backupSwitch.returnedLead', 'Returned to')
    : t('bots.backupSwitch.switchedLead', 'Switched to backup')
  const detail = toPrimary
    ? switched.returnReason === 'manual'
      ? t('bots.backupSwitch.returnedManualDetail', 'returned manually')
      : t('bots.backupSwitch.returnedDetail', 'after usage limit reset')
    : reset
      ? t('bots.backupSwitch.switchedDetailReset', 'while {{from}} is at limit · resets {{time}}', {
          from: fromLabel,
          time: reset
        })
      : t('bots.backupSwitch.switchedDetail', 'while {{from}} is at its usage limit', {
          from: fromLabel
        })
  return (
    <MobileNativeChatEventRow
      icon={
        toPrimary ? (
          <RotateCcw size={14} color={colors.textMuted} strokeWidth={2} />
        ) : (
          <ArrowLeftRight size={14} color={colors.textMuted} strokeWidth={2} />
        )
      }
      label={`${lead} ${targetLabel} · ${detail}`}
      timestamp={timestamp}
      fontScale={fontScale}
    >
      {lead} <MobileNativeChatEventName>{targetLabel}</MobileNativeChatEventName> · {detail}
    </MobileNativeChatEventRow>
  )
}
