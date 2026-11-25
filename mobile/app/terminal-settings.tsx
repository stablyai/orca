import { useCallback, useEffect, useMemo, useState } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { Smartphone } from '../src/components/icons/app-icons'
import { colors, spacing } from '../src/theme/mobile-theme'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import type { Translate } from '../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { loadHosts, peekHosts } from '../src/host-catalog/host-store'
import type { HostProfile } from '../src/host-catalog/host-profile'
import { useFocusedSettingsHostClients } from '../src/settings/settings-host-client-connections'
import type { RpcClient } from '../src/transport/rpc/rpc-client-contract'
import {
  GroupedListScreen,
  LIST_LEADING_INSET,
  ListRow,
  SectionHeader
} from '../src/components/list/ListGroup'
import { PickerModal, type PickerOption } from '../src/components/sheets/PickerModal'
import { TerminalShortcutSettings } from '../src/terminal/shortcuts/settings/TerminalShortcutSettings'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from '../src/terminal/viewport/terminal-auto-restore-fit-state'
import { setDragReorderScrollEnabled } from '../src/components/reorder/drag-reorder-scroll-lock'
import { useTerminalFontSettings } from '../src/terminal/preferences/use-terminal-font-settings'
import {
  TerminalFontPicker,
  TerminalFontSection
} from '../src/terminal/preferences/settings/TerminalFontSettings'
import { TerminalFontPreview } from '../src/terminal/preferences/settings/TerminalFontPreview'
import { getResponsiveLayoutMetrics } from '../src/layout/responsive-layout-metrics'
import { themedStyleSheet } from '../src/theme/themed-styles'
import { NATIVE_SCREEN_HEADER } from '../src/components/nav-bar/ScreenHeader'
import {
  SettingsEmptyRow,
  SettingsNavBar,
  SettingsSection,
  settingsScreenStyles
} from '../src/settings/settings-screen-frame'

type RestoreValue = 'indefinite' | '60s' | '5m' | '30m'

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

  const fontSettings = useTerminalFontSettings()
  const [fontPickerOpen, setFontPickerOpen] = useState(false)
  const window = useWindowDimensions()
  // A wide iPad screen keeps the preview beside the controls instead of scrolling it away.
  const wide = getResponsiveLayoutMetrics(window.width, window.height).isWideLayout
  const preview = (
    <TerminalFontPreview
      textScale={fontSettings.textScale}
      fontStyle={fontSettings.fontStyle}
      columnsWidth={window.width}
      height={wide ? 360 : 180}
    />
  )

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
      setDragReorderScrollEnabled(scrollRef, enabled)
    },
    [scrollRef]
  )
  const handleDragActiveChange = useCallback(
    (active: boolean) => setScrollEnabled(!active),
    [setScrollEnabled]
  )

  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SafeAreaView
        style={settingsScreenStyles.groupedContainer}
        edges={NATIVE_SCREEN_HEADER ? [] : ['top']}
      >
        <SettingsNavBar
          title={t('app.terminalSettings.title', 'Terminal')}
          onBack={() => router.back()}
        />

        <View style={styles.body}>
          <Animated.ScrollView
            ref={scrollRef}
            style={styles.controls}
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
            <GroupedListScreen>
              {wide ? null : <View style={styles.previewSlot}>{preview}</View>}
              <TerminalFontSection
                settings={fontSettings}
                onOpenFontPicker={() => setFontPickerOpen(true)}
              />

              <SettingsSection
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

              <TerminalShortcutSettings
                scrollRef={scrollRef}
                scrollOffsetY={scrollOffsetY}
                scrollContentHeight={scrollContentHeight}
                onDragActiveChange={handleDragActiveChange}
              />

              <SettingsSection>
                <ListRow
                  key="resetFont"
                  title={t('app.terminalSettings.resetFont', 'Reset font settings')}
                  onPress={fontSettings.reset}
                />
              </SettingsSection>
            </GroupedListScreen>
          </Animated.ScrollView>
          {wide ? (
            <View style={styles.widePreview}>
              <SectionHeader first title={t('app.terminalSettings.previewHeading', 'PREVIEW')} />
              {preview}
            </View>
          ) : null}
        </View>
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

      <TerminalFontPicker
        visible={fontPickerOpen}
        settings={fontSettings}
        onClose={() => setFontPickerOpen(false)}
      />
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  body: { flex: 1, flexDirection: 'row' },
  controls: { flex: 1 },
  previewSlot: { paddingTop: spacing.sm },
  widePreview: { flex: 1, paddingTop: spacing.sm, paddingRight: spacing.lg }
}))
