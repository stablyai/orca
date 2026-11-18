import { Text, View } from 'react-native'
import type { ClaudeSessionStatus } from '../../../../../src/shared/native-chat/claude-session-status'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import {
  viewClaudeSessionStatus,
  type ClaudeSessionStatusView
} from './mobile-claude-session-status-view'

function contextColor(tone: NonNullable<ClaudeSessionStatusView['context']>['tone']): string {
  switch (tone) {
    case 'crit':
      return colors.statusRed
    case 'warn':
      return colors.statusAmber
    case 'ok':
      return colors.statusGreen
  }
}

function compactionColor(tone: ClaudeSessionStatusView['compactionTone']): string {
  switch (tone) {
    case 'crit':
      return colors.statusRed
    case 'warn':
      return colors.statusAmber
    case 'neutral':
      return colors.textSecondary
  }
}

/** A read-only line above the composer field: how full the context is and how often it was compacted. */
export function MobileClaudeStatusRow({
  status
}: {
  status: ClaudeSessionStatus | null | undefined
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const view = status ? viewClaudeSessionStatus(status) : null
  if (!view) {
    return null
  }
  const { context } = view
  const color = context ? contextColor(context.tone) : colors.textMuted
  return (
    <View style={styles.row} testID="native-chat-claude-session-status">
      {context?.percent != null ? (
        <>
          <View style={styles.track}>
            <View
              style={[
                styles.fill,
                { width: `${Math.min(context.percent, 100)}%`, backgroundColor: color }
              ]}
            />
          </View>
          <Text style={[styles.text, { color }]}>{`${context.percent}%`}</Text>
        </>
      ) : null}
      {context ? (
        <Text style={styles.text}>
          {context.window ? `${context.used} / ${context.window}` : context.used}
        </Text>
      ) : (
        <Text style={[styles.text, { color }]}>
          {t('chat.claudeSessionStatus.awaitingNextReply', 'context updates after next reply')}
        </Text>
      )}
      <Text style={styles.text}>·</Text>
      <Text style={[styles.text, { color: compactionColor(view.compactionTone) }]}>
        {t('chat.claudeSessionStatus.compacted', 'compacted {{times}}×', {
          times: view.compactions
        })}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs
  },
  track: {
    width: 64,
    height: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    overflow: 'hidden'
  },
  fill: {
    height: '100%',
    borderRadius: radii.pill
  },
  text: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontVariant: ['tabular-nums']
  }
}))
