import { View, Text, Pressable } from 'react-native'
import { Download, Save } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { styles } from './mobile-session-styles'

export function MobileRemoteDraftBar({
  editing,
  changed,
  onReload,
  onKeepMine,
  onExit
}: {
  editing: boolean
  changed: boolean
  onReload: () => void
  onKeepMine: () => void
  onExit: () => void
}) {
  if (!editing && !changed) {
    return null
  }
  return (
    <View style={styles.remoteDraftBar}>
      <Text style={styles.remoteDraftLabel} numberOfLines={1}>
        {changed ? 'Terminal draft changed.' : 'Editing terminal draft'}
      </Text>
      {changed ? (
        <View style={styles.remoteDraftActions}>
          <Pressable
            style={({ pressed }) => [
              styles.remoteDraftAction,
              pressed && styles.accessoryKeyPressed
            ]}
            onPress={onReload}
            accessibilityLabel="Load the terminal draft version"
          >
            <Text style={styles.remoteDraftActionText}>Terminal version</Text>
          </Pressable>
          <Pressable
            style={({ pressed }) => [
              styles.remoteDraftAction,
              pressed && styles.accessoryKeyPressed
            ]}
            onPress={onKeepMine}
            accessibilityLabel="Keep my draft text"
          >
            <Text style={styles.remoteDraftActionText}>Keep mine</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <Text style={styles.remoteDraftHint}>Save writes without Enter</Text>
          <Pressable
            style={({ pressed }) => [
              styles.remoteDraftAction,
              pressed && styles.accessoryKeyPressed
            ]}
            onPress={onExit}
            accessibilityLabel="Stop editing the terminal draft"
          >
            <Text style={styles.remoteDraftActionText}>Exit</Text>
          </Pressable>
        </>
      )}
    </View>
  )
}

export function MobileRemoteDraftFetchActions({
  canSend,
  editing,
  onLoad,
  onSave
}: {
  canSend: boolean
  editing: boolean
  onLoad: () => void
  onSave: () => void
}) {
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.remoteDraftButton,
          pressed && styles.accessoryKeyPressed,
          !canSend && styles.accessoryKeyDisabled
        ]}
        disabled={!canSend}
        onPress={onLoad}
        accessibilityLabel="Load the terminal draft into this field"
      >
        <Download size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
      {editing && (
        <Pressable
          style={({ pressed }) => [
            styles.remoteDraftButton,
            pressed && styles.accessoryKeyPressed,
            !canSend && styles.accessoryKeyDisabled
          ]}
          disabled={!canSend}
          onPress={onSave}
          accessibilityLabel="Save draft to terminal without sending"
        >
          <Save size={16} color={colors.textSecondary} strokeWidth={2.2} />
        </Pressable>
      )}
    </>
  )
}
