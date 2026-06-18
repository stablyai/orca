import { lazy, Suspense } from 'react'
import { StyleSheet, View } from 'react-native'
import { colors } from '../../../../src/theme/mobile-theme'

const LazySessionScreen = lazy(() => import('./mobile-session-screen'))

export default function SessionRoute() {
  return (
    <Suspense fallback={<View style={styles.fallback} />}>
      <LazySessionScreen />
    </Suspense>
  )
}

const styles = StyleSheet.create({
  fallback: {
    flex: 1,
    backgroundColor: colors.bgBase
  }
})
