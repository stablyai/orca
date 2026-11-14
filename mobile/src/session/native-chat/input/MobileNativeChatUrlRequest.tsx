import { Pressable, StyleSheet, Text, View } from 'react-native'
import { readApprovalUrl } from '../../../../../src/shared/agent-session/agent-session-approval-subject'
import type {
  AgentJournalApprovalItem,
  AgentJournalUrlApprovalSubject
} from '../../../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  canOpenExternalLink,
  openExternalLink
} from '../../../platform/external-links/external-link'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { scaledType } from '../transcript/mobile-native-chat-message-styles'

/** Whether this device can open the page; when it can't, Open must not tell the agent it did. */
export function canOpenUrlRequestPage(url: string): boolean {
  const target = readApprovalUrl(url)
  return target !== null && canOpenExternalLink(target.href)
}

/** Opens only in the system browser, outside anything Orca or an agent can read. */
export function openUrlRequestPage(url: string): void {
  const target = readApprovalUrl(url)
  if (target) {
    openExternalLink(target.href)
  }
}

/** Where the page goes: its host to judge it by, then the whole link. */
export function MobileNativeChatUrlTarget({ url }: { url: string }): React.JSX.Element | null {
  useMobileColorScheme()
  const target = readApprovalUrl(url)
  if (!target) {
    return null
  }
  return (
    <View testID="native-chat-url-target" style={styles.target}>
      <Text style={styles.host} numberOfLines={1}>
        {target.host}
      </Text>
      <Text selectable style={styles.href}>
        {target.href}
      </Text>
    </View>
  )
}

/** An opened URL request in the transcript: waiting on the agent, or finished. */
export function MobileNativeChatUrlRequestReceipt({
  body,
  subject,
  finished,
  fontScale
}: {
  body: AgentJournalApprovalItem
  subject: AgentJournalUrlApprovalSubject
  finished: boolean
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const meta = [styles.meta, scaledType(typography.metaSize, fontScale, 5)]
  if (finished) {
    return (
      <View testID="native-chat-url-finished" style={[styles.card, styles.finished]}>
        <Text style={meta} numberOfLines={1}>
          {body.description
            ? t('chat.urlRequest.finishedWith', 'Sign-in finished · {{message}}', {
                message: body.description
              })
            : t('chat.urlRequest.finished', 'Sign-in finished')}
        </Text>
      </View>
    )
  }
  const target = readApprovalUrl(subject.url)
  return (
    <View testID="native-chat-url-opened" style={styles.card}>
      <Text style={[styles.title, scaledType(typography.bodySize, fontScale, 6)]}>
        {t('chat.urlRequest.title', 'Sign-in requested')}
      </Text>
      {body.description ? (
        <Text style={[styles.description, scaledType(typography.bodySize, fontScale, 6)]}>
          {body.description}
        </Text>
      ) : null}
      {target ? (
        <Text style={[meta, styles.mono]} numberOfLines={1}>
          {target.host}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text style={meta}>
          {t('chat.urlRequest.opened', 'Opened the sign-in page in your browser.')}
        </Text>
        {target ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => openUrlRequestPage(target.href)}
            style={({ pressed }) => [styles.again, pressed && styles.pressed]}
          >
            <Text style={[meta, styles.againText]}>
              {t('chat.urlRequest.openAgain', 'Open again')}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  target: {
    gap: spacing.xs
  },
  host: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    lineHeight: typography.metaSize + 5
  },
  href: {
    color: colors.textSecondary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize - 1,
    lineHeight: typography.metaSize + 4
  },
  card: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgPanel
  },
  finished: {
    paddingVertical: spacing.sm
  },
  title: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  description: {
    color: colors.textSecondary
  },
  meta: {
    color: colors.textMuted
  },
  mono: {
    fontFamily: typography.monoFamily
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm
  },
  again: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.control
  },
  againText: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  pressed: {
    opacity: 0.7
  }
}))
