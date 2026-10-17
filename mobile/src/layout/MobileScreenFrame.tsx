import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { colors } from '../theme/mobile-theme'
import { createThemedStyles } from '../theme/mobile-themed-styles'
import { useMobileTheme } from '../theme/use-mobile-theme'

/** Paint the top inset with the header, independently of the scrollable canvas. */
export function MobileScreenFrame({
  header,
  headerSurface = 'panel',
  children
}: {
  header: ReactNode
  headerSurface?: 'base' | 'panel'
  children: ReactNode
}) {
  useMobileTheme()
  return (
    <View style={styles.canvas}>
      <SafeAreaView edges={['top']} style={headerSurface === 'panel' ? styles.panel : styles.base}>
        {header}
      </SafeAreaView>
      <View style={styles.canvas}>{children}</View>
    </View>
  )
}

const styles = createThemedStyles(() =>
  StyleSheet.create({
    canvas: { flex: 1, backgroundColor: colors.bgBase },
    panel: { backgroundColor: colors.bgPanel },
    base: { backgroundColor: colors.bgBase }
  })
)
