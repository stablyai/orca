import { useEffect, useMemo, useState } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { useRouter } from 'expo-router'
import { spacing } from '../src/theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../src/theme/themed-styles'
import { useMobileColors } from '../src/theme/use-mobile-color-scheme'
import type { Translate } from '../src/i18n/mobile-i18n'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { loadHosts, peekHosts } from '../src/host-catalog/host-store'
import type { HostProfile } from '../src/host-catalog/host-profile'
import { useHostDisplay } from '../src/host-descriptors/use-host-display'
import { MachineGlyph } from '../src/home/MobileHomeDesktopRow'
import { useFocusedSettingsHostClients } from '../src/settings/settings-host-client-connections'
import type { RpcClient } from '../src/transport/rpc/rpc-client-contract'
import { LIST_LEADING_INSET, ListRow } from '../src/components/list/ListGroup'
import { PickerModal, type PickerOption } from '../src/components/sheets/PickerModal'
import {
  readTerminalAutoRestoreFitMs,
  saveTerminalAutoRestoreFitMs,
  setTerminalAutoRestoreFitMsForHost
} from '../src/terminal/viewport/terminal-auto-restore-fit-state'
import { useTerminalFontSettings } from '../src/terminal/preferences/use-terminal-font-settings'
import {
  terminalFontLabel,
  terminalPointsLabel
} from '../src/terminal/preferences/settings/TerminalFontSettings'
import { TerminalFontPreview } from '../src/terminal/preferences/settings/TerminalFontPreview'
import { terminalFontPxForScale } from '../src/terminal/preferences/terminal-text-scales'
import {
  SettingsEmptyRow,
  SettingsScreen,
  SettingsSection
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
      label: t('app.terminalSettings.phoneSize', 'Phone size'),
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
  host,
  client,
  ms,
  onPress
}: {
  host: HostProfile
  client: RpcClient | null
  ms: number | null | undefined
  onPress: () => void
}): React.JSX.Element {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const display = useHostDisplay(host)
  // An offline computer can't take the choice, so it says so instead of opening a picker.
  return (
    <ListRow
      title={host.name}
      value={client ? autoRestoreSummary(ms, t) : t('app.terminalSettings.offline', 'Offline')}
      leading={<MachineGlyph kind={display.machineKind} size={18} color={colors.textSecondary} />}
      navigates={client !== null}
      onPress={client ? onPress : undefined}
    />
  )
}

export default function TerminalSettingsScreen() {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const router = useRouter()
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
  const window = useWindowDimensions()
  const fontValue = `${terminalFontLabel(fontSettings.fontStyle.font, t)}, ${terminalPointsLabel(
    terminalFontPxForScale(fontSettings.textScale),
    t
  )}`

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

  return (
    <SettingsScreen
      title={t('app.terminalSettings.title', 'Terminal')}
      onBack={() => router.back()}
      overlays={
        <PickerModal<RestoreValue>
          visible={pickerHost != null}
          title={t('app.terminalSettings.leaveAppHeading', 'When you leave the app')}
          subtitle={pickerHost?.name}
          options={autoRestoreFitOptions(t)}
          selected={valueFromMs(pickerHost ? hostMs[pickerHost.id] : null, t)}
          onSelect={(v) => {
            if (pickerHost) {
              void selectValue(pickerHost.id, v)
            }
          }}
          onClose={() => setPickerHostId(null)}
        />
      }
    >
      <View style={styles.preview}>
        <TerminalFontPreview
          textScale={fontSettings.textScale}
          fontStyle={fontSettings.fontStyle}
          columnsWidth={window.width}
          height={180}
        />
      </View>

      <SettingsSection first>
        <ListRow
          key="font"
          title={t('app.terminalSettings.fontAndSize', 'Font and size')}
          value={fontValue}
          navigates
          onPress={() => router.push('/terminal-font-settings')}
        />
        <ListRow
          key="keys"
          title={t('app.terminalSettings.keyRow', 'Key row')}
          navigates
          onPress={() => router.push('/terminal-keys')}
        />
      </SettingsSection>

      <SettingsSection
        title={t('app.terminalSettings.leaveAppHeading', 'When you leave the app')}
        separatorInset={LIST_LEADING_INSET}
        footer={t(
          'app.terminalSettings.leaveAppFooter',
          'Phone size keeps CLI tools from redrawing.'
        )}
      >
        {hosts.length === 0 ? (
          <SettingsEmptyRow key="empty">
            {t('app.terminalSettings.noComputers', 'No computers paired yet.')}
          </SettingsEmptyRow>
        ) : (
          hosts.map((host) => (
            <HostFitRow
              key={host.id}
              host={host}
              client={hostClientsById.get(host.id) ?? null}
              ms={hostMs[host.id]}
              onPress={() => setPickerHostId(host.id)}
            />
          ))
        )}
      </SettingsSection>
    </SettingsScreen>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  preview: { marginBottom: spacing.lg }
}))
