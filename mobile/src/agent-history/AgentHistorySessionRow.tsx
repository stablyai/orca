import { MobileForkMarkedName } from '../session/fork/MobileForkMarkedName'
import { mobileForkAccessibleName } from '../session/fork/mobile-fork-marked-name'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import { isAntigravityReferenceSession } from '../../../src/shared/agent-session/lifecycle/provider-handles/antigravity-session-origin'
import type {
  MobileAgentHistoryCard,
  MobileAgentHistoryResumeActionState
} from './agent-history-session-card'
import { styles } from './agent-history-styles'

type Props = {
  card: MobileAgentHistoryCard
  session: AiVaultSession | null
  showCurrentWorktreeBadge: boolean
  resumeActionState?: MobileAgentHistoryResumeActionState
  onResume?: (session: AiVaultSession) => void | Promise<void>
  /** What a tap does: resume, or hand the session off while History picks one. */
  primaryAction?: 'resume' | 'handoff'
  onLongPress?: (session: AiVaultSession) => void
}

// One session as a list row: the agent, its title, the last thing said and when; a tap resumes or picks it.
export function AgentHistorySessionRow({
  card,
  session,
  showCurrentWorktreeBadge,
  resumeActionState,
  onResume,
  primaryAction = 'resume',
  onLongPress
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const count = card.messageCount
  const messages =
    count === null
      ? null
      : count === 1
        ? t('agentHistory.sessionHistoryList.messages_one', '{{count}} message', { count })
        : t('agentHistory.sessionHistoryList.messages_other', '{{count}} messages', { count })
  const detail =
    card.lastMessage || (messages ? `${card.agentLabel} · ${messages}` : card.agentLabel)
  const here = showCurrentWorktreeBadge && card.isCurrentWorktree
  const busy = resumeActionState?.loading === true
  const disabled = resumeActionState?.disabled === true || !session || !onResume
  const action =
    primaryAction === 'handoff'
      ? t('agentHistory.handoff.title', 'Hand off to agent')
      : session && isAntigravityReferenceSession(session)
        ? t('agentHistory.sessionHistoryList.continueInCli', 'Continue in CLI')
        : t('agentHistory.sessionHistoryList.resumeSession', 'Resume agent session')

  return (
    <Pressable
      onPress={() => {
        if (session && onResume && !disabled) {
          void onResume(session)
        }
      }}
      onLongPress={session && onLongPress ? () => onLongPress(session) : undefined}
      delayLongPress={onLongPress ? 400 : undefined}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      accessibilityLabel={card.forked ? mobileForkAccessibleName(card.title) : card.title}
      accessibilityHint={action}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.leading}>
        <MobileAgentIcon agentId={card.agent} size={18} />
      </View>
      <View style={styles.main}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {card.forked ? <MobileForkMarkedName name={card.title} /> : card.title}
          </Text>
          {busy ? (
            <ActivityIndicator size="small" color={colors.textSecondary} />
          ) : card.timeAgo ? (
            <Text style={styles.timeAgo}>{card.timeAgo}</Text>
          ) : null}
        </View>
        <Text style={styles.detail} numberOfLines={1}>
          {here ? (
            <Text style={styles.here}>
              {t('agentHistory.sessionHistoryList.thisWorkspace', 'This workspace')}
              {' · '}
            </Text>
          ) : null}
          {detail}
        </Text>
      </View>
    </Pressable>
  )
}
