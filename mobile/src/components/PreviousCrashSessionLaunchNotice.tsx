import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  dismissPreviousMobileCrashSession,
  getUndismissedPreviousMobileCrashSession
} from '../diagnostics/mobile-crash-diagnostics'
import type { MobileCrashSessionSnapshot } from '../diagnostics/mobile-crash-session'
import { colors, spacing } from '../theme/mobile-theme'
import { PreviousCrashSessionBanner } from './PreviousCrashSessionBanner'

export function PreviousCrashSessionLaunchNotice() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [previousCrash, setPreviousCrash] = useState<MobileCrashSessionSnapshot | null>(null)

  useEffect(() => {
    let active = true
    void getUndismissedPreviousMobileCrashSession().then((session) => {
      if (active) {
        setPreviousCrash(session)
      }
    })
    return () => {
      active = false
    }
  }, [])

  const dismiss = useCallback(() => {
    if (!previousCrash) {
      return
    }
    setPreviousCrash(null)
    void dismissPreviousMobileCrashSession(previousCrash.openedAt)
  }, [previousCrash])

  const openTroubleshooting = useCallback(() => {
    dismiss()
    router.push('/troubleshoot')
  }, [dismiss, router])

  if (!previousCrash) {
    return null
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <PreviousCrashSessionBanner
        endedAbnormally={previousCrash.endedAbnormally}
        onDismiss={dismiss}
        onPress={openTroubleshooting}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.bgBase
  }
})
