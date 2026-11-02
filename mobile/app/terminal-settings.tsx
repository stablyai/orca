import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { Smartphone, Type } from 'lucide-react-native'
import { colors, spacing } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import type { Translate } from '../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { loadHosts, peekHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import type { RpcClient } from '../src/transport/rpc-client'
import { LIST_LEADING_INSET, ListRow } from '../src/components/list/ListGroup'
import { PickerModal, type PickerOption } from '../src/components/PickerModal'
import { TerminalShortcutSettings } from '../src/components/TerminalShortcutSettings'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from '../src/terminal/terminal-auto-restore-fit-state'
import { setTerminalSettingsScrollEnabled } from '../src/terminal/terminal-settings-scroll-lock'
import { useTerminalTextScaleSetting } from '../src/terminal/use-terminal-text-scale-setting'
import {
  loadTerminalAutocompleteEnabled,
  saveTerminalAutocompleteEnabled
} from '../src/storage/preferences'
import { MobileSwitch } from '../src/components/MobileSwitch'
import {
  SettingsEmptyRow,
  SettingsNavBar,
  SettingsSection,
  settingsScreenStyles
} from '../src/settings/settings-screen-frame'

type RestoreValue = 'indefinite' | '60s' | '5m' | '30m'

type TextSizeValue = 'smallest' | 'smaller' | 'default' | 'large' | 'larger' | 'largest'

// Baseline zoom sits above fit-to-width; keep presets in sync with TERMINAL_TEXT_SCALES and pinch snapping.
function textSizeOptions(t: Translate): (PickerOption<TextSizeValue> & { scale: number })[] {
  return [
    {
      value: 'smallest',
      label: t('app.terminalSettings.smallestText', 'Smallest (50%)'),
      scale: 0.5
    },
    {
      value: 'smaller',
      label: t('app.terminalSettings.smallerText', 'Smaller (75%)'),
      scale: 0.75
    },
    { value: 'default', label: t('app.terminalSettings.defaultText', 'Default (100%)'), scale: 1 },
    { value: 'large', label: t('app.terminalSettings.largeText', 'Large (125%)'), scale: 1.25 },
    { value: 'larger', label: t('app.terminalSettings.largerText', 'Larger (150%)'), scale: 1.5 },
    { value: 'largest', label: t('app.terminalSettings.largestText', 'Largest (200%)'), scale: 2 }
  ]
}

function textSizeValueFromScale(scale: number, t: Translate): TextSizeValue {
  return textSizeOptions(t).find((o) => o.scale === scale)?.value ?? 'default'
}

function textSizeSummary(scale: number, t: Translate): string {
  const options = textSizeOptions(t)
  return (options.find((o) => o.scale === scale) ?? options[0]!).label
}

function restoreAfterMinutes(t: Translate, count: number): string {
  return count === 1
    ? t('app.terminalSettings.restoreAfterMinutes_one', 'After {{count}} minute', { count })
    : t('app.terminalSettings.restoreAfterMinutes_other', 'After {{count}} minutes', { count })
}

function autoRestoreFitOptions(
  t: Translate
): (PickerOption<RestoreValue> & { ms: number | null })[] {
  return [
    {
      value: 'indefinite',
      label: t('app.terminalSettings.keepPhoneSize', 'Keep at phone size (default)'),
      ms: null
    },
    { value: '60s', label: restoreAfterMinutes(t, 1), ms: 60_000 },
    { value: '5m', label: restoreAfterMinutes(t, 5), ms: 5 * 60_000 },
    { value: '30m', label: restoreAfterMinutes(t, 30), ms: 30 * 60_000 }
  ]
}

function valueFromMs(ms: number | null | undefined, t: Translate): RestoreValue {
  if (ms == null) {
    return 'indefinite'
  }
  const options = autoRestoreFitOptions(t)
  const exact = options.find((o) => o.ms === ms)
  if (exact) {
    return exact.value
  }
  // Snap custom/future/clamped server durations to nearest finite preset so picker agrees with autoRestoreSummary.
  let closest: (typeof options)[number] | null = null
  let bestDelta = Infinity
  for (const opt of options) {
    if (opt.ms == null) {
      continue
    }
    const delta = Math.abs(opt.ms - ms)
    if (delta < bestDelta) {
      bestDelta = delta
      closest = opt
    }
  }
  return closest ? closest.value : 'indefinite'
}

function autoRestoreSummary(ms: number | null | undefined, t: Translate): string {
  if (ms === undefined) {
    return '…'
  }
  if (ms === null) {
    return autoRestoreFitOptions(t)[0]!.label
  }
  const exact = autoRestoreFitOptions(t).find((o) => o.ms === ms)
  if (exact) {
    return exact.label
  }
  const count = Math.round(ms / 1000)
  return count === 1
    ? t('app.terminalSettings.restoreAfterSeconds_one', 'After {{count}}s', { count })
    : t('app.terminalSettings.restoreAfterSeconds_other', 'After {{count}}s', { count })
}

function HostFitRow({
  client,
  hostName,
  ms,
  onPress
}: {
  client: RpcClient | null
  hostName: string
  ms: number | null | undefined
  onPress: () => void
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <ListRow
      title={hostName}
      subtitle={autoRestoreSummary(ms, t)}
      leading={<Smartphone size={18} color={colors.textSecondary} />}
      navigates
      disabled={!client}
      onPress={onPress}
    />
  )
}

export default function TerminalSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>(() => peekHosts() ?? [])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const { clients: hostClients } = useFocusedSettingsHostClients(hostIds)
  const hostClientsById = useMemo(
    () => new Map(hostClients.map((entry) => [entry.hostId, entry.client])),
    [hostClients]
  )

  // Keep host values/picker at screen root: row-nested PickerModal clips drawer backdrop to ScrollView content.
  const [hostMs, setHostMs] = useState<Record<string, number | null | undefined>>({})
  const [pickerHostId, setPickerHostId] = useState<string | null>(null)

  const [textScale, selectTextScale] = useTerminalTextScaleSetting()
  const [textSizePickerOpen, setTextSizePickerOpen] = useState(false)
  const selectTextSize = useCallback(
    (value: TextSizeValue) => {
      const opt = textSizeOptions(t).find((o) => o.value === value)
      if (opt) {
        selectTextScale(opt.scale)
      }
    },
    [selectTextScale, t]
  )

  const [autocompleteEnabled, setAutocompleteEnabled] = useState(false)
  // Fast toggle must win over delayed initial load.
  const userToggledAutocompleteRef = useRef(false)
  useEffect(() => {
    let stale = false
    void loadTerminalAutocompleteEnabled().then((enabled) => {
      if (!stale && !userToggledAutocompleteRef.current) {
        setAutocompleteEnabled(enabled)
      }
    })
    return () => {
      stale = true
    }
  }, [])
  const toggleAutocomplete = useCallback((next: boolean) => {
    userToggledAutocompleteRef.current = true
    setAutocompleteEnabled(next)
    void saveTerminalAutocompleteEnabled(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    for (const host of hosts) {
      const client = hostClientsById.get(host.id) ?? null
      if (!client) {
        continue
      }
      void readTerminalAutoRestoreFitMs(client)
        .catch(() => null)
        .then((value) => {
          if (!cancelled) {
            // Preserve object identity on repeated reconnect/status values to avoid rerendering every row.
            setHostMs((prev) => setTerminalAutoRestoreFitMsForHost(prev, host.id, value))
          }
        })
    }
    return () => {
      cancelled = true
    }
  }, [hosts, hostClientsById])

  async function selectValue(hostId: string, value: RestoreValue) {
    const client = hostClientsById.get(hostId) ?? null
    if (!client) {
      return
    }
    const opt = autoRestoreFitOptions(t).find((o) => o.value === value)
    if (!opt) {
      return
    }
    setHostMs((prev) => setTerminalAutoRestoreFitMsForHost(prev, hostId, opt.ms))
    try {
      const saved = await saveTerminalAutoRestoreFitMs(client, opt.ms)
      setHostMs((prev) => setTerminalAutoRestoreFitMsForHost(prev, hostId, saved))
    } catch {
      try {
        const current = await readTerminalAutoRestoreFitMs(client)
        setHostMs((prev) => setTerminalAutoRestoreFitMsForHost(prev, hostId, current))
      } catch {
        // give up silently — the next mount retries
      }
    }
  }

  const pickerHost = pickerHostId ? hosts.find((h) => h.id === pickerHostId) : null

  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = event.contentOffset.y
  })
  // Toggle imperatively: rerendering during drag rebuilds row gestures and can cancel it.
  const setScrollEnabled = useCallback(
    (enabled: boolean) => {
      setTerminalSettingsScrollEnabled(scrollRef, enabled)
    },
    [scrollRef]
  )
  const handleDragActiveChange = useCallback(
    (active: boolean) => setScrollEnabled(!active),
    [setScrollEnabled]
  )

  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SafeAreaView style={settingsScreenStyles.container} edges={['top']}>
        <SettingsNavBar
          title={t('app.terminalSettings.title', 'Terminal')}
          onBack={() => router.back()}
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
          <SettingsSection
            first
            title={t('app.terminalSettings.leaveAppHeading', 'WHEN YOU LEAVE THE APP')}
            separatorInset={LIST_LEADING_INSET}
            footer={t(
              'app.terminalSettings.leaveAppDescription',
              "While you're using a terminal on your phone, Orca shrinks it to fit your screen. When you close the app or switch away, this controls whether it stays at phone size (so interactive CLI tools don't reflow) or resizes back to your desktop. You can always use Restore on the desktop banner to resize manually."
            )}
          >
            {hosts.length === 0 ? (
              <SettingsEmptyRow key="empty">
                {t(
                  'app.terminalSettings.noPairedDesktops',
                  'No paired desktops yet. Pair one to control terminal behavior.'
                )}
              </SettingsEmptyRow>
            ) : (
              hosts.map((host) => (
                <HostFitRow
                  key={host.id}
                  client={hostClientsById.get(host.id) ?? null}
                  hostName={host.name}
                  ms={hostMs[host.id]}
                  onPress={() => setPickerHostId(host.id)}
                />
              ))
            )}
          </SettingsSection>

          <SettingsSection
            title={t('app.terminalSettings.textSizeHeading', 'TEXT SIZE')}
            footer={t(
              'app.terminalSettings.textSizeDescription',
              "Scale the terminal text. Smaller sizes fit more columns with side margins; larger sizes show fewer columns — drag sideways to pan. You can also pinch to zoom in the terminal itself, which updates this setting. Per-device display only; doesn't change the desktop terminal."
            )}
          >
            <ListRow
              key="textSize"
              title={t('app.terminalSettings.textSize', 'Text size')}
              subtitle={textSizeSummary(textScale, t)}
              leading={<Type size={18} color={colors.textSecondary} />}
              navigates
              onPress={() => setTextSizePickerOpen(true)}
            />
          </SettingsSection>

          <SettingsSection
            title={t('app.terminalSettings.keyboardInputHeading', 'KEYBOARD INPUT')}
            footer={t(
              'app.terminalSettings.keyboardInputDescription',
              'Autocomplete, autocorrect, and spelling suggestions apply only to buffered command input. Use the double-chevron button above the keyboard to switch from live input, then edit your command before tapping Send. Off by default to avoid rewriting commands, flags, or paths.'
            )}
          >
            <ListRow
              key="autocomplete"
              title={t('app.terminalSettings.autocomplete', 'Autocomplete & autocorrect')}
              subtitle={
                autocompleteEnabled
                  ? t('app.terminalSettings.autocompleteOn', 'On')
                  : t('app.terminalSettings.autocompleteOff', 'Off')
              }
              accessory={
                <MobileSwitch
                  accessibilityLabel={t(
                    'app.terminalSettings.autocomplete',
                    'Autocomplete & autocorrect'
                  )}
                  value={autocompleteEnabled}
                  onValueChange={toggleAutocomplete}
                />
              }
            />
          </SettingsSection>

          <TerminalShortcutSettings
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            onDragActiveChange={handleDragActiveChange}
          />
        </Animated.ScrollView>
      </SafeAreaView>

      <PickerModal<RestoreValue>
        visible={pickerHost != null}
        title={
          pickerHost
            ? t('app.terminalSettings.restoreHost', 'Restore {{name}}', { name: pickerHost.name })
            : ''
        }
        options={autoRestoreFitOptions(t)}
        selected={valueFromMs(pickerHost ? hostMs[pickerHost.id] : null, t)}
        onSelect={(v) => {
          if (pickerHost) {
            void selectValue(pickerHost.id, v)
          }
        }}
        onClose={() => setPickerHostId(null)}
      />

      <PickerModal<TextSizeValue>
        visible={textSizePickerOpen}
        title={t('app.terminalSettings.textSizePickerTitle', 'Terminal text size')}
        options={textSizeOptions(t)}
        selected={textSizeValueFromScale(textScale, t)}
        onSelect={selectTextSize}
        onClose={() => setTextSizePickerOpen(false)}
      />
    </GestureHandlerRootView>
  )
}
