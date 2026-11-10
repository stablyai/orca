import { CircleCheck } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { cloudAgentLabel } from './CloudAgentPicker'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/** After a prompt starts an agent on the sandbox: what happened, and where its sign-in lives.
 *  A cloud agent that isn't signed in yet waits in its terminal; the chat view alone would look
 *  empty and invite a resend. */
export function CloudAgentStartedCard(props: {
  agent: string
  onOpenTerminal: (() => void) | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const agent = cloudAgentLabel(props.agent)
  return (
    <View style={styles.startedCard} accessibilityRole="summary">
      <View style={styles.startedHeadline}>
        <CircleCheck size={18} color={colors.textPrimary} strokeWidth={2} />
        <Text style={styles.startedTitle}>
          {t('cloud.started.title', '{{agent}} started with your prompt', { agent })}
        </Text>
      </View>
      <Text style={styles.statusLine}>
        {t(
          'cloud.started.signIn',
          'If {{agent}} isn’t signed in on this sandbox yet, it asks in its terminal. Your prompt is saved and runs once you sign in.',
          { agent }
        )}
      </Text>
      {props.onOpenTerminal ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onOpenTerminal}
          hitSlop={8}
          style={({ pressed }) => [
            styles.errorRetry,
            styles.startedAction,
            pressed && styles.pressed
          ]}
        >
          <Text style={styles.errorRetryText}>
            {t('cloud.started.openTerminal', 'Open terminal to sign in')}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
