import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'expo-router'
import { Pressable, Text, TextInput, View } from 'react-native'
import { ChevronRight, Globe } from 'lucide-react-native'
import {
  getIrohRelayPreset,
  IROH_RELAY_PRESETS,
  parseIrohRelayUrl,
  type IrohRelayPresetId
} from '../../../src/shared/iroh-relay-preference'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { IROH_HOME_RELAY_URL_KEY, subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import { loadIrohHomeRelayUrl, saveIrohHomeRelayUrl } from '../storage/preferences'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsScreen } from './settings-screen-frame'

type RelayChoice = IrohRelayPresetId | 'custom'

/** Edit the phone's home relay without letting stale reads or failed saves replace a committed choice. */
export default function IrohRelaySettingsScreen({ onBack }: { onBack?: () => void }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const router = useRouter()
  const relayLabels: Record<RelayChoice, string> = {
    automatic: t('settings.irohRelayScreen.automatic', 'Automatic (N0)'),
    europe: t('settings.irohRelayScreen.europe', 'Europe'),
    'us-east': t('settings.irohRelayScreen.usEast', 'US-East'),
    'us-west': t('settings.irohRelayScreen.usWest', 'US-West'),
    asia: t('settings.irohRelayScreen.asia', 'Asia / Singapore'),
    custom: t('settings.irohRelayScreen.custom', 'Custom HTTPS')
  }
  const relayOptions: PickerOption<RelayChoice>[] = [
    ...IROH_RELAY_PRESETS.map(({ id, relayUrl }) => ({
      value: id,
      label: relayLabels[id],
      subtitle:
        relayUrl ??
        t('settings.irohRelayScreen.defaultRelaysDescription', 'Use the default N0 relays.')
    })),
    {
      value: 'custom',
      label: relayLabels.custom,
      subtitle: t(
        'settings.irohRelayScreen.customRelayDescription',
        'Enter a single HTTPS relay origin.'
      )
    }
  ]
  const invalidCustomRelay = t(
    'settings.irohRelayScreen.invalidCustomRelay',
    'Enter a single HTTPS relay origin without credentials, paths, queries, or fragments.'
  )
  const [selected, setSelected] = useState<RelayChoice>('automatic')
  const [customUrl, setCustomUrl] = useState('')
  const [relayUrl, setRelayUrl] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const savedUrl = useRef<string | null>(null)
  const revision = useRef(0)
  const active = useRef(false)
  const savingRef = useRef(false)

  const acceptSavedRelay = useCallback((url: string | null) => {
    revision.current += 1
    savedUrl.current = url
    setRelayUrl(url)
    setSelected(getIrohRelayPreset(url))
    setCustomUrl(url ?? '')
    setLoaded(true)
    setLoading(false)
    setError(null)
  }, [])

  useEffect(() => {
    active.current = true
    let current = true
    const startedAt = revision.current
    setLoading(true)
    const unsubscribe = subscribeMirroredKey(IROH_HOME_RELAY_URL_KEY, (raw) => {
      let url: string | null
      try {
        url = parseIrohRelayUrl(raw)
      } catch {
        url = null
      }
      acceptSavedRelay(url)
    })
    void loadIrohHomeRelayUrl().then(
      (url) => {
        if (current && revision.current === startedAt) {
          acceptSavedRelay(url)
        }
      },
      () => {
        if (current && revision.current === startedAt) {
          setLoading(false)
          setError(
            t(
              'settings.irohRelayScreen.loadFailed',
              'Could not load the phone relay preference. Try again.'
            )
          )
        }
      }
    )
    return () => {
      current = false
      active.current = false
      unsubscribe()
    }
  }, [acceptSavedRelay, loadAttempt, t])

  /** Serialize durable saves and avoid overwriting newer mirrored preferences or unmounted UI. */
  const saveRelay = async (url: string | null) => {
    if (!loaded || savingRef.current) {
      return
    }
    savingRef.current = true
    const startedAt = revision.current
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      await saveIrohHomeRelayUrl(url)
      if (active.current) {
        // The mirrored notification may already have delivered this or a newer committed choice.
        if (revision.current === startedAt) {
          acceptSavedRelay(url)
        }
        setStatus(
          t(
            'settings.irohRelayScreen.saved',
            'Saved. Iroh connections will reconnect using this phone preference.'
          )
        )
      }
    } catch {
      if (active.current) {
        setSelected(getIrohRelayPreset(savedUrl.current))
        setCustomUrl(savedUrl.current ?? '')
        setError(
          t(
            'settings.irohRelayScreen.saveFailed',
            'Could not save the phone relay preference. The previous selection is still active.'
          )
        )
      }
    } finally {
      savingRef.current = false
      if (active.current) {
        setSaving(false)
      }
    }
  }
  const disabled = !loaded || saving
  const statusText = loading
    ? t('settings.irohRelayScreen.loading', 'Loading phone relay preference...')
    : saving
      ? t('settings.irohRelayScreen.saving', 'Saving phone relay preference...')
      : (status ??
        (loaded
          ? t('settings.irohRelayScreen.loaded', 'Phone relay preference loaded.')
          : t('settings.irohRelayScreen.unavailable', 'Phone relay preference unavailable.')))

  return (
    <>
      <SettingsScreen
        title={t('settings.irohRelayScreen.title', 'Iroh relay')}
        onBack={onBack ?? (() => router.back())}
      >
        <Text style={styles.description}>
          {t(
            'settings.irohRelayScreen.description',
            "Home relay for this phone, used by all Iroh connections. This does not change your desktop's relay or its saved pairing hint. Direct and LAN connections remain enabled. You can change this setting while offline or if a relay is unavailable."
          )}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t(
            'settings.irohRelayScreen.homeRelayAccessibilityLabel',
            'Phone Iroh home relay'
          )}
          accessibilityValue={{
            text: loaded
              ? relayLabels[selected]
              : t('settings.irohRelayScreen.notLoaded', 'Not loaded')
          }}
          accessibilityState={{ disabled, busy: loading || saving }}
          disabled={disabled}
          onPress={() => setPickerOpen(true)}
          style={({ pressed }) => [
            styles.row,
            pressed && styles.pressed,
            disabled && styles.disabled
          ]}
        >
          <Globe size={16} color={colors.textSecondary} />
          <View style={styles.rowContent}>
            <Text style={styles.label}>
              {t('settings.irohRelayScreen.homeRelay', 'Phone home relay')}
            </Text>
            <Text style={styles.description}>
              {loaded
                ? relayLabels[selected]
                : t('settings.irohRelayScreen.loadingPreference', 'Loading preference')}
            </Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
        {selected === 'custom' && (
          <View style={styles.customForm}>
            <Text style={styles.label}>
              {t('settings.irohRelayScreen.customRelay', 'Custom HTTPS relay')}
            </Text>
            <TextInput
              accessibilityLabel={t(
                'settings.irohRelayScreen.customUrlLabel',
                'Custom Iroh relay URL'
              )}
              accessibilityHint={t(
                'settings.irohRelayScreen.customUrlHint',
                'Enter an HTTPS origin, then use Save relay to apply it.'
              )}
              accessibilityState={{ disabled }}
              editable={!disabled}
              style={styles.input}
              value={customUrl}
              onChangeText={(value) => {
                setCustomUrl(value)
                setError(null)
                setStatus(null)
              }}
              placeholder={t(
                'settings.irohRelayScreen.customUrlPlaceholder',
                'https://relay.example.com/'
              )}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="url"
              returnKeyType="done"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('settings.irohRelayScreen.saveRelay', 'Save relay')}
              accessibilityState={{ disabled: disabled || !customUrl.trim(), busy: saving }}
              disabled={disabled || !customUrl.trim()}
              style={[styles.button, (disabled || !customUrl.trim()) && styles.disabled]}
              onPress={() => {
                if (disabled || !customUrl.trim()) {
                  return
                }
                let url: string | null
                try {
                  url = parseIrohRelayUrl(customUrl)
                } catch {
                  setError(invalidCustomRelay)
                  return
                }
                if (url === null) {
                  setError(invalidCustomRelay)
                  return
                }
                void saveRelay(url)
              }}
            >
              <Text style={styles.label}>
                {t('settings.irohRelayScreen.saveRelay', 'Save relay')}
              </Text>
            </Pressable>
            <Text style={styles.description}>
              {t(
                'settings.irohRelayScreen.draftHint',
                'Draft changes are not applied until you save.'
              )}
            </Text>
          </View>
        )}
        {loaded && (
          <Text style={styles.description}>
            {t('settings.irohRelayScreen.savedHomeRelay', 'Saved home relay: {{relay}}', {
              relay: relayUrl ?? relayLabels.automatic
            })}
          </Text>
        )}
        <Text
          accessibilityLabel={t('settings.irohRelayScreen.statusLabel', 'Iroh relay status')}
          accessibilityValue={{ text: statusText }}
          accessibilityLiveRegion="polite"
          style={styles.description}
        >
          {statusText}
        </Text>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!loading && !loaded && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              'settings.irohRelayScreen.retryLabel',
              'Retry loading relay preference'
            )}
            style={styles.button}
            onPress={() => {
              setError(null)
              setLoadAttempt((attempt) => attempt + 1)
            }}
          >
            <Text style={styles.label}>{t('settings.irohRelayScreen.tryAgain', 'Try again')}</Text>
          </Pressable>
        )}
      </SettingsScreen>
      <PickerModal<RelayChoice>
        visible={pickerOpen}
        title={t('settings.irohRelayScreen.homeRelayAccessibilityLabel', 'Phone Iroh home relay')}
        options={relayOptions}
        selected={selected}
        onSelect={(choice) => {
          if (disabled) {
            return
          }
          setError(null)
          setStatus(null)
          if (choice === 'custom') {
            setSelected('custom')
            setCustomUrl(savedUrl.current ?? '')
          } else {
            const preset = IROH_RELAY_PRESETS.find(({ id }) => id === choice)!
            void saveRelay(preset.relayUrl)
          }
        }}
        onClose={() => setPickerOpen(false)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  description: { color: colors.textSecondary, fontSize: typography.bodySize - 1, lineHeight: 20 },
  label: { color: colors.textPrimary, fontSize: typography.bodySize, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgPanel,
    borderRadius: radii.surface,
    padding: spacing.md,
    marginVertical: spacing.md
  },
  rowContent: { flex: 1 },
  pressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.5 },
  customForm: { gap: spacing.sm, marginBottom: spacing.md },
  input: {
    color: colors.textPrimary,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.control,
    padding: spacing.md,
    fontSize: typography.bodySize
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.control,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg
  },
  error: { color: colors.statusRed, fontSize: typography.bodySize - 1, marginVertical: spacing.sm }
}))
