import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { ChevronLeft, ChevronRight, Smartphone, Type } from 'lucide-react-native'
import { colors, spacing } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import type { Translate } from '../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import type { RpcClient } from '../src/transport/rpc-client'
import { PickerModal, type PickerOption } from '../src/components/PickerModal'
import { TerminalShortcutSettings } from '../src/components/TerminalShortcutSettings'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from '../src/terminal/terminal-auto-restore-fit-state'
import { terminalSettingsScreenStyles as styles } from '../src/terminal/terminal-settings-screen-styles'
import { setTerminalSettingsScrollEnabled } from '../src/terminal/terminal-settings-scroll-lock'
import { useTerminalTextScaleSetting } from '../src/terminal/use-terminal-text-scale-setting'
import {
  loadTerminalAutocompleteEnabled,
  saveTerminalAutocompleteEnabled
} from '../src/storage/preferences'

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
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      disabled={!client}
    >
      <Smartphone size={16} color={colors.textSecondary} />
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{hostName}</Text>
        <Text style={styles.rowSublabel}>{autoRestoreSummary(ms, t)}</Text>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

export default function TerminalSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>([])
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
    <GestureHandlerRootView style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.back', 'Back')}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>{t('app.terminalSettings.title', 'Terminal')}</Text>
      </View>

      <Animated.ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          scrollContentHeight.value = height
        }}
      >
        <Text style={styles.groupHeading}>
          {t('app.terminalSettings.leaveAppHeading', 'WHEN YOU LEAVE THE APP')}
        </Text>
        <Text style={styles.groupDescription}>
          {t(
            'app.terminalSettings.leaveAppDescription',
            "While you're using a terminal on your phone, Orca shrinks it to fit your screen. When you close the app or switch away, this controls whether it stays at phone size (so interactive CLI tools don't reflow) or resizes back to your desktop. You can always use Restore on the desktop banner to resize manually."
          )}
        </Text>

        {hosts.length === 0 ? (
          <View style={[styles.section, styles.sectionTopGap]}>
            <Text style={styles.emptyText}>
              {t(
                'app.terminalSettings.noPairedDesktops',
                'No paired desktops yet. Pair one to control terminal behavior.'
              )}
            </Text>
          </View>
        ) : (
          <View style={[styles.section, styles.sectionTopGap]}>
            {hosts.map((host, idx) => {
              const client = hostClientsById.get(host.id) ?? null
              return (
                <View key={host.id}>
                  {idx > 0 && <View style={styles.separator} />}
                  <HostFitRow
                    client={client}
                    hostName={host.name}
                    ms={hostMs[host.id]}
                    onPress={() => setPickerHostId(host.id)}
                  />
                </View>
              )
            })}
          </View>
        )}

        <Text style={[styles.groupHeading, styles.inputGroupGap]}>
          {t('app.terminalSettings.textSizeHeading', 'TEXT SIZE')}
        </Text>
        <Text style={styles.groupDescription}>
          {t(
            'app.terminalSettings.textSizeDescription',
            "Scale the terminal text. Smaller sizes fit more columns with side margins; larger sizes show fewer columns — drag sideways to pan. You can also pinch to zoom in the terminal itself, which updates this setting. Per-device display only; doesn't change the desktop terminal."
          )}
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setTextSizePickerOpen(true)}
          >
            <Type size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>{t('app.terminalSettings.textSize', 'Text size')}</Text>
              <Text style={styles.rowSublabel}>{textSizeSummary(textScale, t)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>

        <Text style={[styles.groupHeading, styles.inputGroupGap]}>
          {t('app.terminalSettings.keyboardInputHeading', 'KEYBOARD INPUT')}
        </Text>
        <Text style={styles.groupDescription}>
          {t(
            'app.terminalSettings.keyboardInputDescription',
            'Autocomplete, autocorrect, and spelling suggestions apply only to buffered command input. Use the double-chevron button above the keyboard to switch from live input, then edit your command before tapping Send. Off by default to avoid rewriting commands, flags, or paths.'
          )}
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>
                {t('app.terminalSettings.autocomplete', 'Autocomplete & autocorrect')}
              </Text>
              <Text style={styles.rowSublabel}>
                {autocompleteEnabled
                  ? t('app.terminalSettings.autocompleteOn', 'On')
                  : t('app.terminalSettings.autocompleteOff', 'Off')}
              </Text>
            </View>
            <Switch
              value={autocompleteEnabled}
              onValueChange={toggleAutocomplete}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
        </View>

        <TerminalShortcutSettings
          scrollRef={scrollRef}
          scrollOffsetY={scrollOffsetY}
          scrollContentHeight={scrollContentHeight}
          onDragActiveChange={handleDragActiveChange}
        />
      </Animated.ScrollView>

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
