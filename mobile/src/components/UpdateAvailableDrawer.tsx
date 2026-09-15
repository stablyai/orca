import { useCallback } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import type { AppUpdatePrompt } from '../updates/use-app-update-check'

type Props = {
  prompt: AppUpdatePrompt | null
  onDismiss: () => void
}

export function UpdateAvailableDrawer({ prompt, onDismiss }: Props) {
  const releaseUrl = prompt?.release.url
  const openRelease = useCallback(() => {
    if (releaseUrl) {
      void Linking.openURL(releaseUrl)
    }
    onDismiss()
  }, [onDismiss, releaseUrl])

  return (
    <BottomDrawer visible={prompt !== null} onClose={onDismiss}>
      <View style={styles.header}>
        <Text style={styles.title}>Update available</Text>
        <Text style={styles.message}>
          {prompt
            ? `Orca Mobile ${prompt.release.version} is out — you're on ${prompt.currentVersion}. Sideloaded builds don't update themselves, so grab the new APK.`
            : ''}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          style={({ pressed }) => [styles.laterButton, pressed && styles.buttonPressed]}
          onPress={onDismiss}
          accessibilityRole="button"
        >
          <Text style={styles.laterText}>Later</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.downloadButton, pressed && styles.buttonPressed]}
          onPress={openRelease}
          accessibilityRole="button"
        >
          <Text style={styles.downloadText}>Get the APK</Text>
        </Pressable>
      </View>
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  message: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: 2,
    lineHeight: 18
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.md
  },
  laterButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  downloadButton: {
    backgroundColor: colors.textPrimary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.button
  },
  buttonPressed: {
    opacity: 0.7
  },
  laterText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  downloadText: {
    color: colors.bgBase,
    fontSize: typography.bodySize,
    fontWeight: '600'
  }
})
