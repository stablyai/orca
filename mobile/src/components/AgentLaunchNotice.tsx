import { useState } from 'react'
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import {
  AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE,
  AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE
} from '../session/mobile-existing-agent-launch'
import type { MobileAgentLaunchAvailability } from '../session/mobile-agent-launch-availability'
import { colors, spacing, typography } from '../theme/mobile-theme'

type Props = {
  availability: MobileAgentLaunchAvailability
  error: string | null
  /** The prompt of an agent that started without it, offered for the user to paste in. */
  undeliveredPrompt: string | null
  errorStyle: StyleProp<TextStyle>
}

/** The status line under an AI button that starts an agent with a prompt. */
export function AgentLaunchNotice({ availability, error, undeliveredPrompt, errorStyle }: Props) {
  const clipboard = useClipboardWriter()
  const [copyState, setCopyState] = useState<{ prompt: string; label: string } | null>(null)
  const message =
    availability === 'update-required'
      ? AGENT_LAUNCH_UPDATE_REQUIRED_MESSAGE
      : availability === 'unverified'
        ? AGENT_LAUNCH_STATUS_UNREADABLE_MESSAGE
        : error
  if (!message) {
    return null
  }
  const copyLabel =
    copyState && copyState.prompt === undeliveredPrompt ? copyState.label : 'Copy prompt'
  return (
    <View style={styles.notice}>
      <Text style={errorStyle}>{message}</Text>
      {undeliveredPrompt ? (
        <Pressable
          onPress={() => {
            clipboard.writeText(undeliveredPrompt).then(
              () => setCopyState({ prompt: undeliveredPrompt, label: 'Copied' }),
              () => setCopyState({ prompt: undeliveredPrompt, label: "Couldn't copy" })
            )
          }}
          accessibilityRole="button"
          accessibilityLabel="Copy prompt"
          hitSlop={spacing.sm}
        >
          <Text style={styles.copyText}>{copyLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  notice: {
    gap: spacing.xs
  },
  copyText: {
    color: colors.accentBlue,
    fontSize: typography.metaSize,
    fontWeight: '600'
  }
})
