import { useCallback, useState } from 'react'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { ArrowUpDown } from 'lucide-react-native'
import { spacing } from '../src/theme/mobile-theme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { NavBarButton } from '../src/components/nav-bar/NavBarButton'
import { setDragReorderScrollEnabled } from '../src/components/reorder/drag-reorder-scroll-lock'
import { TerminalShortcutSettings } from '../src/terminal/shortcuts/settings/TerminalShortcutSettings'
import { SettingsNavBar, settingsScreenStylesSheet } from '../src/settings/settings-screen-frame'
import { useThemedStyles } from '../src/theme/themed-styles'

export default function TerminalKeysScreen() {
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [editing, setEditing] = useState(false)

  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = event.contentOffset.y
  })
  // Toggle imperatively: rerendering during drag rebuilds row gestures and can cancel it.
  const handleDragActiveChange = useCallback(
    (active: boolean) => setDragReorderScrollEnabled(scrollRef, !active),
    [scrollRef]
  )

  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SafeAreaView style={settingsScreenStyles.container} edges={['top']}>
        <SettingsNavBar
          title={t('app.terminalSettings.keyRow', 'Key row')}
          onBack={() => router.back()}
          trailing={
            <NavBarButton
              icon={ArrowUpDown}
              active={editing}
              accessibilityLabel={
                editing
                  ? t('app.terminalSettings.doneReordering', 'Done reordering')
                  : t('app.terminalSettings.reorderKeys', 'Reorder keys')
              }
              onPress={() => setEditing((value) => !value)}
            />
          }
        />
        <Animated.ScrollView
          ref={scrollRef}
          contentContainerStyle={[
            settingsScreenStyles.scrollContent,
            { paddingBottom: insets.bottom + spacing.xl }
          ]}
          showsVerticalScrollIndicator={false}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          onContentSizeChange={(_width, height) => {
            scrollContentHeight.value = height
          }}
        >
          <TerminalShortcutSettings
            editing={editing}
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            onDragActiveChange={handleDragActiveChange}
          />
        </Animated.ScrollView>
      </SafeAreaView>
    </GestureHandlerRootView>
  )
}
