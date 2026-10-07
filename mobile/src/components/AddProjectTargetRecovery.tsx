import { Pressable, Text, View } from 'react-native'

export function AddProjectTargetRecovery({ onChooseThisHost }: { onChooseThisHost: () => void }) {
  return (
    <View>
      <Text>That SSH target is no longer available. Choose This host or go back.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose This host"
        onPress={onChooseThisHost}
      >
        <Text>Choose This host</Text>
      </Pressable>
    </View>
  )
}
