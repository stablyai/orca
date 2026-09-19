import { Pressable, Text, View } from 'react-native'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'

/**
 * The question Back asks when a terminal-artifact draft is unsaved.
 *
 * A row under the header rather than a modal: `Alert` is a no-op on React Native Web and the app's
 * `ConfirmModal` is a `BottomDrawer`, whose animated style never reaches the DOM node on WKWebView
 * (C1.9), so both are invisible inside the shell's page. This paints the same on every platform
 * with no animation and no native dialog behind it.
 */
export function MobileFilePreviewDiscardPrompt({
  onStay,
  onDiscard
}: {
  onStay: () => void
  onDiscard: () => void
}) {
  return (
    <View style={styles.discardPrompt} accessibilityRole="alert">
      <Text style={styles.discardPromptText}>Discard unsaved edits?</Text>
      <Pressable
        style={({ pressed }) => [
          styles.discardPromptAction,
          pressed && styles.discardPromptActionPressed
        ]}
        onPress={onStay}
        accessibilityRole="button"
        accessibilityLabel="Keep editing"
      >
        <Text style={styles.discardPromptStayText}>Stay</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.discardPromptAction,
          pressed && styles.discardPromptActionPressed
        ]}
        onPress={onDiscard}
        accessibilityRole="button"
        accessibilityLabel="Discard unsaved edits and leave"
      >
        <Text style={styles.discardPromptDiscardText}>Discard</Text>
      </Pressable>
    </View>
  )
}
