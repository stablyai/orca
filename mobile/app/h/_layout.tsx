import { Stack } from 'expo-router'
import { colors } from '../../src/theme/mobile-theme'

export default function HostGroupLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bgBase }
      }}
    >
      <Stack.Screen name="[hostId]/index" options={{ title: 'Host' }} />
      <Stack.Screen name="[hostId]/session/[worktreeId]" options={{ title: 'Terminal' }} />
    </Stack>
  )
}
