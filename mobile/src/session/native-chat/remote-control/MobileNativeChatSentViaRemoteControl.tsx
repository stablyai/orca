import { Text, View } from 'react-native'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { MobileClaudeRemoteControlIcon } from './MobileClaudeRemoteControlIcon'

/** Under a prompt the person sent from Claude's own apps, which Orca saw only as Claude's echo. */
export function MobileNativeChatSentViaRemoteControl(): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.row} testID="native-chat-sent-via-remote-control">
      <MobileClaudeRemoteControlIcon size={12} surface="chat" />
      <Text style={styles.text}>{t('chat.remoteControl.sentFrom', 'Sent via Remote Control')}</Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-end',
    gap: spacing.sm,
    paddingTop: spacing.xs
  },
  text: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
}))
