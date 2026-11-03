import { useEffect, useState } from 'react'
import { useRouter } from 'expo-router'
import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  loadRelayBackgroundExtended,
  saveRelayBackgroundExtended
} from '../storage/relay-background-preference'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'

export default function ConnectionSettingsScreen({ onBack }: { onBack?: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const [extended, setExtended] = useState<boolean | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'load' | 'save' | null>(null)

  useEffect(() => {
    let active = true
    void loadRelayBackgroundExtended().then(
      (value) => {
        if (active) {
          setExtended(value)
        }
      },
      () => {
        if (active) {
          setExtended(false)
          setError('load')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const label = t(
    'settings.connectionSettingsScreen.keepRelayLonger',
    'Keep Relay connected longer'
  )
  const save = async (value: boolean) => {
    if (saving || extended === null) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await saveRelayBackgroundExtended(value)
      setExtended(value)
    } catch {
      setError('save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SettingsScreen
      title={t('settings.connectionSettingsScreen.title', 'Connections')}
      onBack={onBack ?? (() => router.back())}
    >
      <SettingsSection
        first
        footer={t(
          'settings.connectionSettingsScreen.backgroundDescription',
          'Keep an existing Relay connection for up to 5 minutes instead of 30 seconds when you switch apps. Your phone may suspend the connection sooner. This can use more battery and mobile data. Applies the next time Orca goes into the background.'
        )}
      >
        <ListRow
          title={label}
          accessory={
            <MobileSwitch
              accessibilityLabel={label}
              value={extended ?? false}
              disabled={saving || extended === null}
              onValueChange={(value) => void save(value)}
            />
          }
        />
      </SettingsSection>
      {error ? (
        <SettingsNote>
          {error === 'load'
            ? t(
                'settings.connectionSettingsScreen.loadError',
                'Could not load connection preferences'
              )
            : t(
                'settings.connectionSettingsScreen.saveError',
                'Could not save connection preferences'
              )}
        </SettingsNote>
      ) : null}
    </SettingsScreen>
  )
}
