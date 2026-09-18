import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Text } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { NotificationDeliverySection } from '../notifications/NotificationDeliverySection'
import {
  DEFAULT_NOTIFICATION_DELIVERY,
  loadNotificationDeliveryPreferences,
  type NotificationDeliveryPreferences
} from '../notifications/notification-delivery-preferences'
import { setNotificationDeliveryPreferences } from '../notifications/push-registration'
import { useRemotePushCapableHosts } from '../notifications/use-remote-push-capable-hosts'
import { colors, spacing, typography } from '../theme/mobile-theme'

export function NativeNotificationDeliverySettings({ enabled }: { enabled: boolean }) {
  const [delivery, setDelivery] = useState(DEFAULT_NOTIFICATION_DELIVERY)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refreshRevision = useRef(0)
  const saveInProgress = useRef(false)
  const support = useRemotePushCapableHosts()
  const refresh = useCallback(async () => {
    if (saveInProgress.current) {
      return
    }
    const revision = ++refreshRevision.current
    try {
      const value = await loadNotificationDeliveryPreferences()
      if (revision !== refreshRevision.current) {
        return
      }
      setDelivery(value)
      setLoaded(true)
      setError(null)
    } catch {
      if (revision !== refreshRevision.current) {
        return
      }
      setError('Could not load delivery settings. Reopen this screen to retry.')
    }
  }, [])
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh])
  )
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh()
      }
    })
    return () => subscription.remove()
  }, [refresh])
  const change = async (value: NotificationDeliveryPreferences) => {
    if (saveInProgress.current) {
      return
    }
    saveInProgress.current = true
    refreshRevision.current += 1
    setSaving(true)
    setError(null)
    try {
      await setNotificationDeliveryPreferences(value)
      setDelivery(value)
    } catch {
      setError('Could not save delivery settings. Try again.')
    } finally {
      saveInProgress.current = false
      setSaving(false)
    }
  }
  const hintStyle = {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    marginTop: spacing.md
  }
  return (
    <>
      <NotificationDeliverySection
        value={delivery}
        disabled={!enabled || !loaded || saving}
        onChange={(value) => void change(value)}
      />
      {error && (
        <Text accessibilityRole="alert" style={hintStyle}>
          {error}
        </Text>
      )}
      {support.resolved && !support.supported && (
        <Text style={hintStyle}>
          Pair an updated desktop to receive notifications on this phone.
        </Text>
      )}
    </>
  )
}
