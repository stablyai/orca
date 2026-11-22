import { Stack } from 'expo-router'
import { nativeHeaderOptions } from '../../components/nav-bar/native-header-options'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { homeTabLabels, type HomeTabId } from '../tabs/home-tabs'

/** A Home tab's own stack, so its native header (large title on iOS) sits under the tab bar. */
export function MobileHomeTabStack({ tab }: { tab: HomeTabId }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <Stack
      screenOptions={{
        ...nativeHeaderOptions(),
        contentStyle: { backgroundColor: colors.bgBase }
      }}
    >
      {/* Titled before the tab first mounts its body, which sets the same header. */}
      <Stack.Screen
        name="index"
        options={{ title: homeTabLabels(t)[tab], headerLargeTitle: true }}
      />
    </Stack>
  )
}
