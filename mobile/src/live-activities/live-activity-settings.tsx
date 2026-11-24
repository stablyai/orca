import {
  useLiveActivityDeliveryFailed,
  useLiveActivityCleanupPending
} from './live-activity-delivery-status'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/controls/MobileSwitch'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { nativeLiveActivities } from './native-live-activities'
import {
  loadLiveActivityPreferences,
  type LiveActivityPreferences
} from './live-activity-preferences'
import { setLiveActivityPreferences, retryLiveActivityCleanup } from './live-activity-sync'

export function LiveActivitySettings() {
  const t = useMobileTranslation()
  const deliveryFailed = useLiveActivityDeliveryFailed()
  const cleanupPending = useLiveActivityCleanupPending()
  const revision = useRef(0)
  const [value, setValue] = useState<LiveActivityPreferences>({ enabled: false, showNames: false })
  const [authorized, setAuthorized] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const busy = useRef(false)
  const [saving, setSaving] = useState(false)
  const refresh = useCallback(async () => {
    if (busy.current) {
      return
    }
    const current = ++revision.current
    try {
      const [preferences, allowed] = await Promise.all([
        loadLiveActivityPreferences(),
        nativeLiveActivities?.authorization() ?? false
      ])
      if (busy.current || current !== revision.current) {
        return
      }
      setValue(preferences)
      setAuthorized(allowed)
      setReady(true)
    } catch {
      if (current === revision.current && !busy.current) {
        setError(true)
      }
    }
  }, [])
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh])
  )
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh()
      }
    })
    return () => sub.remove()
  }, [refresh])
  if (Platform.OS !== 'ios') {
    return null
  }
  const change = async (next: LiveActivityPreferences) => {
    if (busy.current || (next.enabled && !value.enabled && !authorized)) {
      return
    }
    revision.current++
    busy.current = true
    setSaving(true)
    setError(false)
    try {
      await setLiveActivityPreferences(next)
      setValue(next)
    } catch {
      const saved = await loadLiveActivityPreferences().catch(() => null)
      if (saved) {
        setValue(saved)
      }
      setError(true)
    } finally {
      busy.current = false
      setSaving(false)
    }
  }
  const enabledLabel = t('liveActivities.enable', 'Live Activities')
  const namesLabel = t('liveActivities.showNames', 'Show session names')
  return (
    <>
      <SettingsSection
        title={enabledLabel}
        footer={t(
          'liveActivities.description',
          'See agent totals across paired computers and servers. Names stay hidden unless you enable them.'
        )}
      >
        <ListRow
          title={enabledLabel}
          accessory={
            <MobileSwitch
              accessibilityLabel={enabledLabel}
              value={value.enabled}
              disabled={!ready || saving || (!authorized && !value.enabled)}
              onValueChange={(enabled) => void change({ ...value, enabled })}
            />
          }
        />
        <ListRow
          title={namesLabel}
          accessory={
            <MobileSwitch
              accessibilityLabel={namesLabel}
              value={value.showNames}
              disabled={!ready || !value.enabled || saving}
              onValueChange={(showNames) => void change({ ...value, showNames })}
            />
          }
        />
      </SettingsSection>
      {value.enabled && deliveryFailed ? (
        <SettingsNote error>
          {t(
            'liveActivities.deliveryFailed',
            'Live Activity updates could not be registered. Update the paired host and its push service, then open a working session to retry.'
          )}
        </SettingsNote>
      ) : null}
      {ready && !authorized ? (
        <SettingsNote>
          {nativeLiveActivities
            ? t(
                'liveActivities.systemDisabled',
                'Live Activities are unavailable or disabled in iOS Settings for Orca.'
              )
            : t(
                'liveActivities.rebuild',
                'Install an iOS build with Live Activities support. Expo Go is not supported.'
              )}
        </SettingsNote>
      ) : null}
      {cleanupPending ? (
        <SettingsSection
          footer={t(
            'liveActivities.cleanupPending',
            'Your preference is saved. Some Live Activity cleanup is pending and will retry when the host reconnects.'
          )}
        >
          <ListRow
            title={t('liveActivities.retryCleanup', 'Retry cleanup')}
            busy={saving}
            onPress={() => {
              if (busy.current) {
                return
              }
              revision.current++
              busy.current = true
              setSaving(true)
              void retryLiveActivityCleanup()
                .catch(() => setError(true))
                .finally(() => {
                  busy.current = false
                  setSaving(false)
                })
            }}
          />
        </SettingsSection>
      ) : null}
      {error ? (
        <SettingsNote error>
          {t('liveActivities.saveFailed', 'Could not update Live Activities. Try again.')}
        </SettingsNote>
      ) : null}
    </>
  )
}
