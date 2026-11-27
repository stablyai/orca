// As the desktop's GhSignedOutLine: the one line a GitHub surface adds while gh is signed out on the
// computer the bot runs on.
import { Text, View } from 'react-native'
import { MobileSourceCopyButton } from '../../components/code-presentation/MobileSourceCopyButton'
import { LIST_ROW_PADDING } from '../../components/list/ListGroup'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { scaledType } from '../../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import { colors, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'

const GH_AUTH_LOGIN = 'gh auth login'

/** `card`: a chat card's meta line at the chat's font scale; otherwise a settings page's note. */
export function MobileGhSignedOutLine({
  host,
  card
}: {
  /** The computer's name: on the phone, "this computer" would be the phone. */
  host: string
  card?: { fontScale: number }
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={[styles.line, !card && styles.note]}>
      <View style={styles.dot} />
      <Text
        style={[
          styles.text,
          card ? [styles.meta, scaledType(typography.metaSize, card.fontScale, 4)] : styles.noteText
        ]}
      >
        {t(
          'bots.github.ghSignedOut.line',
          'gh is signed out on {{host}}. Run gh auth login there.',
          {
            host
          }
        )}
      </Text>
      <MobileSourceCopyButton
        text={GH_AUTH_LOGIN}
        accessibilityLabel={t('bots.github.ghSignedOut.copy', 'Copy {{text}}', {
          text: GH_AUTH_LOGIN
        })}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm - 2 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.statusAmber },
  text: { flexShrink: 1 },
  // As SettingsNote and MobileBotCardMeta.
  note: { paddingHorizontal: LIST_ROW_PADDING, paddingTop: spacing.sm },
  noteText: { fontSize: 13, lineHeight: 18, color: colors.textSecondary },
  meta: { color: colors.textMuted }
}))
