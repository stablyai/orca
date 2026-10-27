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
import {
  loadTerminalAutocompleteEnabled,
  loadTerminalTextScale,
  saveTerminalAutocompleteEnabled,
  saveTerminalTextScale
} from '../src/storage/preferences'

type RestoreValue = 'indefinite' | '60s' | '5m' | '30m'

type TextSizeValue = 'smallest' | 'smaller' | 'default' | 'large' | 'larger' | 'largest'

// Baseline zoom sits above fit-to-width; keep presets in sync with TERMINAL_TEXT_SCALES and pinch snapping.
const TEXT_SIZE_OPTIONS: (PickerOption<TextSizeValue> & { scale: number })[] = [
  { value: 'smallest', label: 'Smallest (50%)', scale: 0.5 },
  { value: 'smaller', label: 'Smaller (75%)', scale: 0.75 },
  { value: 'default', label: 'Default (100%)', scale: 1 },
  { value: 'large', label: 'Large (125%)', scale: 1.25 },
  { value: 'larger', label: 'Larger (150%)', scale: 1.5 },
  { value: 'largest', label: 'Largest (200%)', scale: 2 }
]

function textSizeValueFromScale(scale: number): TextSizeValue {
  return TEXT_SIZE_OPTIONS.find((o) => o.scale === scale)?.value ?? 'default'
}

function textSizeSummary(scale: number): string {
  return (TEXT_SIZE_OPTIONS.find((o) => o.scale === scale) ?? TEXT_SIZE_OPTIONS[0]!).label
}

const AUTO_RESTORE_FIT_OPTIONS: (PickerOption<RestoreValue> & { ms: number | null })[] = [
  { value: 'indefinite', label: 'Keep at phone size (default)', ms: null },
  { value: '60s', label: 'After 1 minute', ms: 60_000 },
  { value: '5m', label: 'After 5 minutes', ms: 5 * 60_000 },
  { value: '30m', label: 'After 30 minutes', ms: 30 * 60_000 }
]

function valueFromMs(ms: number | null | undefined): RestoreValue {
  if (ms == null) {
    return 'indefinite'
  }
  const exact = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  if (exact) {
    return exact.value
  }
  // Snap custom/future/clamped server durations to nearest finite preset so picker agrees with autoRestoreSummary.
  let closest: (typeof AUTO_RESTORE_FIT_OPTIONS)[number] | null = null
  let bestDelta = Infinity
  for (const opt of AUTO_RESTORE_FIT_OPTIONS) {
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

function autoRestoreSummary(ms: number | null | undefined): string {
  if (ms === undefined) {
    return '…'
  }
  if (ms === null) {
    return AUTO_RESTORE_FIT_OPTIONS[0]!.label
  }
  const exact = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.ms === ms)
  return exact ? exact.label : `After ${Math.round(ms / 1000)}s`
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
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      disabled={!client}
    >
      <Smartphone size={16} color={colors.textSecondary} />
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{hostName}</Text>
        <Text style={styles.rowSublabel}>{autoRestoreSummary(ms)}</Text>
      </View>
      <ChevronRight size={16} color={colors.textMuted} />
    </Pressable>
  )
}

export default function TerminalSettingsScreen() {
  useMobileColorScheme()
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

  const [textScale, setTextScale] = useState(1)
  const [textSizePickerOpen, setTextSizePickerOpen] = useState(false)
  useEffect(() => {
    void loadTerminalTextScale().then(setTextScale)
  }, [])
  const selectTextSize = useCallback((value: TextSizeValue) => {
    const opt = TEXT_SIZE_OPTIONS.find((o) => o.value === value)
    if (!opt) {
      return
    }
    setTextScale(opt.scale)
    void saveTerminalTextScale(opt.scale)
  }, [])

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
    const opt = AUTO_RESTORE_FIT_OPTIONS.find((o) => o.value === value)
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
          accessibilityLabel="Back"
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Terminal</Text>
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
        <Text style={styles.groupHeading}>WHEN YOU LEAVE THE APP</Text>
        <Text style={styles.groupDescription}>
          While you&apos;re using a terminal on your phone, Orca shrinks it to fit your screen. When
          you close the app or switch away, this controls whether it stays at phone size (so
          interactive CLI tools don&apos;t reflow) or resizes back to your desktop. You can always
          use Restore on the desktop banner to resize manually.
        </Text>

        {hosts.length === 0 ? (
          <View style={[styles.section, styles.sectionTopGap]}>
            <Text style={styles.emptyText}>
              No paired desktops yet. Pair one to control terminal behavior.
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

        <Text style={[styles.groupHeading, styles.inputGroupGap]}>TEXT SIZE</Text>
        <Text style={styles.groupDescription}>
          Scale the terminal text. Smaller sizes fit more columns with side margins; larger sizes
          show fewer columns — drag sideways to pan. You can also pinch to zoom in the terminal
          itself, which updates this setting. Per-device display only; doesn&apos;t change the
          desktop terminal.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setTextSizePickerOpen(true)}
          >
            <Type size={16} color={colors.textSecondary} />
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Text size</Text>
              <Text style={styles.rowSublabel}>{textSizeSummary(textScale)}</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>

        <Text style={[styles.groupHeading, styles.inputGroupGap]}>KEYBOARD INPUT</Text>
        <Text style={styles.groupDescription}>
          Autocomplete, autocorrect, and spelling suggestions apply only to buffered command input.
          Use the double-chevron button above the keyboard to switch from live input, then edit your
          command before tapping Send. Off by default to avoid rewriting commands, flags, or paths.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Autocomplete &amp; autocorrect</Text>
              <Text style={styles.rowSublabel}>{autocompleteEnabled ? 'On' : 'Off'}</Text>
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
        title={pickerHost ? `Restore ${pickerHost.name}` : ''}
        options={AUTO_RESTORE_FIT_OPTIONS}
        selected={valueFromMs(pickerHost ? hostMs[pickerHost.id] : null)}
        onSelect={(v) => {
          if (pickerHost) {
            void selectValue(pickerHost.id, v)
          }
        }}
        onClose={() => setPickerHostId(null)}
      />

      <PickerModal<TextSizeValue>
        visible={textSizePickerOpen}
        title="Terminal text size"
        options={TEXT_SIZE_OPTIONS}
        selected={textSizeValueFromScale(textScale)}
        onSelect={selectTextSize}
        onClose={() => setTextSizePickerOpen(false)}
      />
    </GestureHandlerRootView>
  )
}
