import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { Radio } from 'lucide-react-native'
import { ListRow } from '../components/list/ListGroup'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { loadRelayBackgroundGraceMs, saveRelayBackgroundGraceMs } from '../storage/preferences'
import { RELAY_BACKGROUND_GRACE_MS } from '../transport/relay/mobile-relay-background-grace'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsNote, SettingsScreen, SettingsSection } from './settings-screen-frame'

type GracePreset = '30s' | '1m' | '5m'
const PRESETS: readonly { value: GracePreset; ms: number }[] = [
  { value: '30s', ms: RELAY_BACKGROUND_GRACE_MS },
  { value: '1m', ms: 60_000 },
  { value: '5m', ms: 5 * 60_000 }
]

export default function RelaySettingsScreen({
  onBack
}: {
  onBack?: () => void
}): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const [graceMs, setGraceMs] = useState(RELAY_BACKGROUND_GRACE_MS)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const revision = useRef(0)
  const failedRevision = useRef<number | null>(null)
  const savedMs = useRef(RELAY_BACKGROUND_GRACE_MS)
  const hasSaved = useRef(false)

  useEffect(() => {
    let active = true
    void loadRelayBackgroundGraceMs().then(
      (loaded) => {
        if (!hasSaved.current) {
          savedMs.current = loaded
        }
        if (active && (revision.current === 0 || failedRevision.current === revision.current)) {
          setGraceMs(savedMs.current)
        }
      },
      () => {
        if (active) {
          setError('load')
        }
      }
    )
    return () => {
      active = false
    }
  }, [])

  const select = useCallback((preset: GracePreset) => {
    setError(null)
    const next = revision.current + 1
    revision.current = next
    const ms = PRESETS.find((item) => item.value === preset)?.ms ?? RELAY_BACKGROUND_GRACE_MS
    setGraceMs(ms)
    void saveRelayBackgroundGraceMs(ms).then(
      () => {
        savedMs.current = ms
        hasSaved.current = true
      },
      () => {
        if (revision.current === next) {
          failedRevision.current = next
          setGraceMs(savedMs.current)
          setError('save')
        }
      }
    )
  }, [])

  const options: PickerOption<GracePreset>[] = [
    {
      value: '30s',
      label: t('settings.relaySettings.thirtySeconds', '30 seconds')
    },
    {
      value: '1m',
      label: t('settings.relaySettings.oneMinute', '1 minute')
    },
    {
      value: '5m',
      label: t('settings.relaySettings.fiveMinutes', '5 minutes')
    }
  ]
  const selected = options.find(
    (option) => PRESETS.find((p) => p.value === option.value)?.ms === graceMs
  )
  const title = t('settings.relaySettings.backgroundGrace', 'Relay background grace')

  return (
    <SettingsScreen
      title={t('settings.relaySettings.title', 'Relay')}
      onBack={onBack ?? (() => router.back())}
      overlays={
        <PickerModal<GracePreset>
          visible={pickerOpen}
          title={title}
          options={options}
          selected={selected?.value ?? '30s'}
          onSelect={select}
          onClose={() => setPickerOpen(false)}
        />
      }
    >
      <SettingsSection
        first
        title={t('settings.relaySettings.heading', 'CONNECTION')}
        footer={
          <>
            <SettingsNote>
              {t(
                'settings.relaySettings.description',
                'How long a healthy relay stays connected after you leave the app. The system may still stop the app sooner.'
              )}
            </SettingsNote>
            {error ? (
              <SettingsNote error>
                {error === 'load'
                  ? t(
                      'settings.relaySettings.loadFailed',
                      'Could not load relay settings. Try again.'
                    )
                  : t(
                      'settings.relaySettings.saveFailed',
                      'Could not save relay settings. Try again.'
                    )}
              </SettingsNote>
            ) : null}
          </>
        }
      >
        <ListRow
          key="relayGrace"
          title={title}
          subtitle={selected?.label ?? options[0]!.label}
          leading={<Radio size={18} color={colors.textSecondary} />}
          navigates
          accessibilityLabel={title}
          onPress={() => setPickerOpen(true)}
        />
      </SettingsSection>
    </SettingsScreen>
  )
}
