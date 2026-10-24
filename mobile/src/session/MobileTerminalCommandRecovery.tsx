import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useState } from 'react'
import { useClipboardWriter } from '../platform/clipboard'
import { colors, spacing, typography } from '../theme/mobile-theme'

type Props = {
  command: string
  pending: boolean
  canEdit: boolean
  onEdit: () => void
  onDismiss: () => void
}

export function MobileTerminalCommandRecovery({
  command,
  pending,
  canEdit,
  onEdit,
  onDismiss
}: Props) {
  const clipboard = useClipboardWriter()
  const [feedback, setFeedback] = useState<{ command: string; text: string } | null>(null)
  return (
    <View style={styles.recovery} accessibilityLiveRegion="polite">
      <Text style={styles.title}>
        {pending ? 'Waiting for command confirmation…' : 'Command delivery not confirmed'}
      </Text>
      <Text style={styles.detail}>
        {pending
          ? 'Your command is kept here while the computer replies.'
          : 'This command may already have run. Check the terminal before retrying.'}
      </Text>
      <ScrollView style={styles.preview} nestedScrollEnabled>
        <Text selectable style={styles.command}>
          {command || '(Enter)'}
        </Text>
      </ScrollView>
      {!pending && (
        <View style={styles.actions}>
          <Pressable
            style={styles.button}
            onPress={() => {
              void clipboard.writeText(command).then(
                () => setFeedback({ command, text: 'Copied' }),
                () => setFeedback({ command, text: 'Could not copy' })
              )
            }}
            accessibilityRole="button"
          >
            <Text style={styles.action}>
              {feedback?.command === command ? feedback.text : 'Copy command'}
            </Text>
          </Pressable>
          <Pressable
            style={styles.button}
            disabled={!canEdit}
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityHint="Returns the saved command to the editor without sending it"
            accessibilityState={{ disabled: !canEdit }}
          >
            <Text style={[styles.action, !canEdit && styles.disabled]}>Edit for retry</Text>
          </Pressable>
          <Pressable
            style={styles.button}
            onPress={onDismiss}
            accessibilityRole="button"
            accessibilityHint="Removes this saved command and keeps your current draft"
          >
            <Text style={styles.action}>Dismiss</Text>
          </Pressable>
        </View>
      )}
      {!pending && !canEdit && (
        <Text style={styles.detail}>
          Clear your newer draft to edit this command, or copy it first.
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  recovery: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle
  },
  title: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '600' },
  detail: { color: colors.textSecondary, fontSize: typography.metaSize },
  preview: { maxHeight: 80 },
  command: {
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  button: { paddingVertical: spacing.sm },
  action: { color: colors.textSecondary, fontSize: typography.metaSize, fontWeight: '600' },
  disabled: { color: colors.textMuted }
})
