// One MCP servers page: Back, the centred title over its subtitle, the grouped content on the grey
// page, and the bar's hairline only once the content scrolls under it.
import { useRef, type ReactNode } from 'react'
import { Animated, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { settingsScreenStylesSheet } from '../settings/settings-screen-frame'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'

export function McpPageFrame(props: {
  title: string
  subtitle?: string
  onBack: () => void
  trailing?: ReactNode
  /** A centred loading or empty state fills the space under the bar. */
  fill?: boolean
  /** A bar pinned under the content, such as Sign in; the content scrolls clear of it. */
  footer?: ReactNode
  children: ReactNode
}) {
  const styles = useThemedStyles(stylesSheet)
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  const t = useMobileTranslation()
  const insets = useSafeAreaInsets()
  const scrollY = useRef(new Animated.Value(0)).current
  const dividerOpacity = scrollY.interpolate({
    inputRange: [0, spacing.sm],
    outputRange: [0, 1],
    extrapolate: 'clamp'
  })
  return (
    <View style={styles.page}>
      <SafeAreaView edges={['top']} style={styles.page}>
        <NavBar
          style={styles.bar}
          dividerOpacity={dividerOpacity}
          leading={
            <NavBarButton
              icon={ChevronLeft}
              accessibilityLabel={t('common.back', 'Back')}
              onPress={props.onBack}
            />
          }
          title={props.title}
          subtitle={props.subtitle || undefined}
          trailing={props.trailing}
        />
        <Animated.ScrollView
          contentContainerStyle={[
            settingsScreenStyles.scrollContent,
            props.fill && settingsScreenStyles.fill,
            { paddingBottom: insets.bottom + (props.footer ? 96 : spacing.xl) }
          ]}
          onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
            useNativeDriver: false
          })}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator={false}
        >
          {props.children}
        </Animated.ScrollView>
      </SafeAreaView>
      {props.footer ? (
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.sm }]}>
          {props.footer}
        </View>
      ) : null}
    </View>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  page: { flex: 1, backgroundColor: colors.sheetSurface },
  bar: { backgroundColor: colors.sheetSurface },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    backgroundColor: colors.sheetSurface
  }
}))
