import { useContext } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, spacing, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { MOBILE_QUEUED_EDIT_SCOPE_PREFIX } from '../../mobile-queued-message-edit-open'
import {
  MobileDictationAutoSendContext,
  type MobileDictationAutoSend,
  useMobileDictationAutoSendCountdown
} from '../../mobile-dictation-auto-send'

// Send saves a queued-message edit, so an edit composer never takes part in auto-send.
function useSurfaceAutoSend(sendSurfaceId: string): MobileDictationAutoSend | null {
  const autoSend = useContext(MobileDictationAutoSendContext)
  return sendSurfaceId.startsWith(MOBILE_QUEUED_EDIT_SCOPE_PREFIX) ? null : autoSend
}

// The composer's takeover gestures, a queued-message edit's included, withdraw the chat's pending send.
export function useDictationAutoSend(): {
  withdraw: () => void
  withdrawBefore: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result
  ) => (...args: Args) => Result
} {
  const autoSend = useContext(MobileDictationAutoSendContext)
  const withdraw = (): void => autoSend?.withdraw()
  return {
    withdraw,
    withdrawBefore:
      (handler) =>
      (...args) => {
        withdraw()
        return handler(...args)
      }
  }
}

export function DictationAutoSendRow({
  sendSurfaceId,
  onSend
}: {
  sendSurfaceId: string
  onSend: () => Promise<void>
}): React.JSX.Element {
  const autoSend = useSurfaceAutoSend(sendSurfaceId)
  const t = useMobileTranslation()
  const { secondsLeft, announcement } = useMobileDictationAutoSendCountdown(
    autoSend,
    sendSurfaceId,
    () => void onSend()
  )
  return (
    <>
      {/* Always mounted so a web live region announces its first text; empty while idle. */}
      <Text
        style={styles.announcement}
        accessibilityLiveRegion="polite"
        testID="native-chat-dictation-auto-send-announcement"
      >
        {announcement ?? ''}
      </Text>
      {secondsLeft !== null ? (
        <View style={styles.row} testID="native-chat-dictation-auto-send">
          <Text style={styles.text} aria-hidden>
            {t('chat.dictationAutoSend.sendingIn', 'Sending in {{seconds}}s', {
              seconds: secondsLeft
            })}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.dictationAutoSend.cancelSending', 'Cancel sending')}
            hitSlop={8}
            onPress={() => autoSend?.withdraw()}
          >
            <Text style={styles.cancel}>{t('chat.dictationAutoSend.cancel', 'Cancel')}</Text>
          </Pressable>
        </View>
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingBottom: spacing.xs
  },
  text: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  cancel: {
    color: colors.textPrimary,
    fontSize: typography.metaSize,
    fontWeight: '600'
  },
  // Screen-reader only: present for the live region, invisible on screen.
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden'
  }
}))
