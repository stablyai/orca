// Under the owner's Orca-typed message on the phone: its Slack post's Posting or failed line.
import { Pressable, Text, View } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import { MobileConnectorSourceIcon } from '../../../bots/MobileConnectorSourceIcon'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { slackMirrorPostLine } from '../../../../../src/shared/connectors/slack-mirror-post-line'
import { useMobileSlackMirrorContext } from './use-mobile-slack-mirror'
import { useMobileSlackMirrorCopy } from './mobile-slack-mirror-copy'

/** Under the owner's Orca-typed message: Posting to Slack…, or Not posted with Retry and Dismiss. */
export function MobileSlackMirrorPostLine({
  messageId
}: {
  messageId: string
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const say = useMobileSlackMirrorCopy()
  const mirror = useMobileSlackMirrorContext()
  const line = slackMirrorPostLine(mirror?.link.mirrorPosts?.[messageId])
  if (!mirror || !line) {
    return null
  }
  if (line.kind === 'posting') {
    return (
      <View style={styles.line}>
        <MobileConnectorSourceIcon source="slack" size={12} />
        <Text style={styles.meta}>{say(line.copy)}</Text>
      </View>
    )
  }
  return (
    <View style={styles.line}>
      <CircleAlert size={12} color={colors.statusRed} />
      <Text style={styles.failed}>{say(line.copy)}</Text>
      {mirror.link.mirrorBlocked ? null : (
        <Pressable onPress={() => void mirror.post(messageId, 'retry')} hitSlop={8}>
          <Text style={styles.action}>
            {t('components.native-chat.slackMirror.retry', 'Retry')}
          </Text>
        </Pressable>
      )}
      <Pressable onPress={() => void mirror.post(messageId, 'dismiss')} hitSlop={8}>
        <Text style={styles.action}>
          {t('components.native-chat.dismissDeliveryNotice', 'Dismiss')}
        </Text>
      </Pressable>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  meta: { fontSize: typography.metaSize, color: colors.textMuted },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xxs
  },
  failed: { fontSize: typography.metaSize, color: colors.statusRed },
  action: { fontSize: typography.metaSize, color: colors.textSecondary, fontWeight: '500' }
}))
