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
      <Stack.Screen name="[hostId]/accounts" options={{ title: 'Accounts' }} />
      <Stack.Screen name="[hostId]/tasks" options={{ title: 'Tasks' }} />
      <Stack.Screen name="[hostId]/session/[worktreeId]" options={{ title: 'Terminal' }} />
      <Stack.Screen
        name="[hostId]/source-control/[worktreeId]"
        options={{ title: 'Source Control' }}
      />
      <Stack.Screen name="[hostId]/review/[worktreeId]" options={{ title: 'Review Changes' }} />
    </Stack>
  )
}
