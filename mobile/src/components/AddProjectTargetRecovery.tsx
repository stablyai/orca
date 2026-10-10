import { Pressable, Text, View } from 'react-native'
import { newWorktreeFormStyles } from './new-worktree-form-styles'

export function AddProjectTargetRecovery({ onChooseThisHost }: { onChooseThisHost: () => void }) {
  return (
    <View>
      <Text style={newWorktreeFormStyles.emptyText}>
        That SSH target is no longer available. Choose This host to continue.
      </Text>
      <Pressable
        style={newWorktreeFormStyles.createButton}
        accessibilityRole="button"
        accessibilityLabel="Choose This host"
        onPress={onChooseThisHost}
      >
        <Text style={newWorktreeFormStyles.createText}>Choose This host</Text>
      </Pressable>
    </View>
  )
}
