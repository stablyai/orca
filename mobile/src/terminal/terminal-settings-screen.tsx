import { useCallback } from 'react'
import { View, Text, Pressable, Switch, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { ChevronLeft, ChevronRight, Smartphone, Type } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { PickerModal } from '../components/PickerModal'
import { TerminalShortcutSettings } from '../components/TerminalShortcutSettings'
import { terminalSettingsScreenStyles as styles } from './terminal-settings-screen-styles'
import {
  TEXT_SIZE_OPTIONS,
  AUTO_RESTORE_FIT_OPTIONS,
  textSizeValueFromScale,
  textSizeSummary,
  valueFromMs,
  autoRestoreSummary,
  type RestoreValue,
  type TextSizeValue
} from './terminal-settings-options'
import type {
  TerminalSettingsHost,
  TerminalSettingsOperations
} from './terminal-settings-operations'
import { useTerminalSettingsState } from './use-terminal-settings-state'
function HostFitRow({
  available,
  hostName,
  ms,
  onPress
}: {
  available: boolean
  hostName: string
  ms: number | null | undefined
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Restore ${hostName}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      disabled={!available}
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

export default function TerminalSettingsScreen({
  hosts,
  operations,
  onBack,
  hostUnavailableMessage,
  scope = 'device'
}: {
  scope?: 'device' | 'host'
  hostUnavailableMessage?: string
  hosts: TerminalSettingsHost[]
  operations: TerminalSettingsOperations
  onBack: () => void
}) {
  const insets = useSafeAreaInsets()
  const {
    hostMs,
    pickerHostId,
    setPickerHostId,
    textScale,
    textSizePickerOpen,
    setTextSizePickerOpen,
    autocompleteEnabled,
    selectTextSize,
    toggleAutocomplete,
    selectValue,
    busy,
    error
  } = useTerminalSettingsState(hosts, operations)
  const pickerHost = pickerHostId ? hosts.find((h) => h.id === pickerHostId) : null
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = event.contentOffset.y
  })
  // Why: imperative toggle instead of state — a re-render while a drag gesture
  // is active would rebuild the row gestures and could cancel the drag.
  const setScrollEnabled = useCallback(
    (enabled: boolean) => {
      scrollRef.current?.setNativeProps({ scrollEnabled: enabled })
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
          accessibilityLabel="Back"
          accessibilityRole="button"
          style={styles.backButton}
          onPress={onBack}
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
        {error && (
          <Text accessibilityRole="alert" style={styles.groupDescription}>
            {error}
          </Text>
        )}
        <Text style={styles.groupHeading}>WHEN YOU LEAVE THE APP</Text>
        <Text style={styles.groupDescription}>
          While you&apos;re using a terminal on your phone, Orca shrinks it to fit your screen. When
          you close the app or switch away, this controls whether it stays at phone size (so
          interactive CLI tools don&apos;t reflow) or resizes back to your desktop. You can always
          use Restore this terminal or Restore all terminals on the banner to resize manually.
        </Text>

        {hosts.length === 0 ? (
          <View style={[styles.section, styles.sectionTopGap]}>
            <Text style={styles.emptyText}>
              {hostUnavailableMessage ??
                'No paired desktops yet. Pair one to control terminal behavior.'}
            </Text>
          </View>
        ) : (
          <View style={[styles.section, styles.sectionTopGap]}>
            {hosts.map((host, idx) => {
              return (
                <View key={host.id}>
                  {idx > 0 && <View style={styles.separator} />}
                  <HostFitRow
                    available={!busy && hostMs[host.id] !== undefined}
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
          itself, which updates this setting. Display only
          {scope === 'host' ? ' on this device for this paired host' : ' on this device'};
          doesn&apos;t change the desktop terminal.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            accessibilityRole="button"
            accessibilityLabel="Text size"
            disabled={busy}
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
          Enable phone-style autocomplete, autocorrect, and spelling suggestions in the terminal
          command bar. Off by default so the keyboard never rewrites commands, flags, or paths.
          Direct keyboard input (when keys go straight to the terminal) always sends raw keystrokes,
          so suggestions don&apos;t apply there.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Autocomplete &amp; autocorrect</Text>
              <Text style={styles.rowSublabel}>{autocompleteEnabled ? 'On' : 'Off'}</Text>
            </View>
            <Switch
              accessibilityLabel="Autocomplete and autocorrect"
              accessibilityState={{ busy, disabled: busy }}
              disabled={busy}
              value={autocompleteEnabled}
              onValueChange={toggleAutocomplete}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
              {...(Platform.OS === 'web' ? { activeThumbColor: colors.textPrimary } : {})}
            />
          </View>
        </View>

        <TerminalShortcutSettings
          preferences={operations}
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
