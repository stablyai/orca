import { Stack } from 'expo-router'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { HOST_STACK_SCREENS, type HostStackAnimation } from './host-stack-screens'

export function HostStack({ animation }: { animation: HostStackAnimation }) {
  const t = useMobileTranslation()
  const colors = useMobileColors()
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bgBase },
        // Swap tablet detail panes instantly so slides cannot reveal the outgoing pane’s underlying screen; phones retain native slides.
        animation
      }}
    >
      {HOST_STACK_SCREENS.map(({ name, title }) => (
        <Stack.Screen key={name} name={name} options={{ title: title(t) }} />
      ))}
    </Stack>
  )
}
