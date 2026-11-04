import { useState } from 'react'
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  availability: MobileAgentLaunchAvailability
  /** The confirmation that the agent started with its prompt. */
  success: string | null
  error: string | null
  /** The host's note on a launch that went ahead; secondary text, not an error. */
  warning: string | null
  /** The prompt of an agent that started without it, offered for the user to paste in. */
  undeliveredPrompt: string | null
  errorStyle: StyleProp<TextStyle>
}

/** The status line under an AI button that starts an agent with a prompt. */
export function AgentLaunchNotice({
  availability,
  success,
  error,
  warning,
  undeliveredPrompt,
  errorStyle
}: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const clipboard = useClipboardWriter()
  const [copyState, setCopyState] = useState<{
    prompt: string
    status: 'copied' | 'failed'
  } | null>(null)
  const availabilityMessage =
    availability === 'update-required'
      ? t(
          'components.agentLaunchNotice.updateRequired',
          'Update Orca on your computer to start an agent from your phone.'
        )
      : availability === 'unverified'
        ? t(
            'components.agentLaunchNotice.statusUnreadable',
            "Could not read this host's status. Retrying…"
          )
        : null
  const message = availabilityMessage ?? error
  const note = availabilityMessage ? null : warning
  const confirmation = message ? null : success
  if (!message && !note && !confirmation) {
    return null
  }
  const copyLabel =
    copyState && copyState.prompt === undeliveredPrompt
      ? copyState.status === 'copied'
        ? t('common.copied', 'Copied')
        : t('components.agentLaunchNotice.copyFailed', "Couldn't copy")
      : t('components.agentLaunchNotice.copyPrompt', 'Copy prompt')
  return (
    <View style={styles.notice}>
      {confirmation ? <Text style={styles.successText}>{confirmation}</Text> : null}
      {message ? <Text style={errorStyle}>{message}</Text> : null}
      {note ? <Text style={styles.warningText}>{note}</Text> : null}
      {undeliveredPrompt ? (
        <Pressable
          onPress={() => {
            clipboard.writeText(undeliveredPrompt).then(
              () => setCopyState({ prompt: undeliveredPrompt, status: 'copied' }),
              () => setCopyState({ prompt: undeliveredPrompt, status: 'failed' })
            )
          }}
          accessibilityRole="button"
          accessibilityLabel={t('components.agentLaunchNotice.copyPrompt', 'Copy prompt')}
          hitSlop={spacing.sm}
        >
          <Text style={styles.copyText}>{copyLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  notice: {
    gap: spacing.xs
  },
  successText: {
    color: colors.statusGreen,
    fontSize: typography.metaSize
  },
  warningText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize
  },
  copyText: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
}))
