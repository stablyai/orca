import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { View, Text, StyleSheet, Pressable, Platform } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import { ChevronLeft, Copy, Check, Send } from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { ConnectionLog } from '../src/components/ConnectionLog'
import { loadHosts } from '../src/transport/host-store'
import { connectionLogStore } from '../src/transport/persisted-connection-log-store'
import { useHostClient } from '../src/transport/client-context'
import {
  useConnectionPathStatus,
  useLastConnectedAt,
  useReconnectAttempt
} from '../src/transport/client-context-connection-metrics'
import { buildConnectionDiagnosticsReport } from '../src/diagnostics/connection-diagnostics-report'
import { diagnoseConnection } from '../src/diagnostics/connection-diagnostics-analysis'
import { submitConnectionDiagnostics } from '../src/diagnostics/connection-diagnostics-submission'
import { useHostStatusGates } from '../src/transport/host-status-gates'
import { loadHostAppVersion } from '../src/transport/host-app-version-store'
import type { ConnectionLogEntry, HostProfile } from '../src/transport/types'

// Why: getSnapshot must be referentially stable when there's no data —
// a fresh [] per call would make useSyncExternalStore re-render forever.
const EMPTY_ENTRIES: readonly ConnectionLogEntry[] = []

// Why: reading the log is most needed while a host is failing, so this
// screen also *acquires* the host client — opening it kicks a dial and the
// log fills live instead of showing a stale tail.
export default function ConnectionLogScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const insets = useSafeAreaInsets()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [submissionState, setSubmissionState] = useState<'idle' | 'sending' | 'sent' | 'failed'>(
    'idle'
  )

  useEffect(() => {
    let stale = false
    void loadHosts().then((loaded) => {
      if (stale) {
        return
      }
      setHosts(loaded)
      setSelectedId((prev) => prev ?? params.hostId ?? loaded[0]?.id ?? null)
    })
    return () => {
      stale = true
    }
  }, [params.hostId])

  const selected = hosts.find((h) => h.id === selectedId) ?? null
  const { client, state } = useHostClient(selected?.id)
  const { desktopAppVersion: liveDesktopAppVersion } = useHostStatusGates({
    hostId: selected?.id,
    client,
    connState: state
  })
  const reconnectAttempts = useReconnectAttempt(selected?.id)
  const lastConnectedAt = useLastConnectedAt(selected?.id)
  const { activePath, pendingPath } = useConnectionPathStatus(selected?.id)

  useEffect(() => {
    if (selectedId) {
      void connectionLogStore.hydrate(selectedId)
    }
  }, [selectedId])

  const subscribe = useCallback(
    (listener: () => void) =>
      selectedId ? connectionLogStore.subscribe(selectedId, listener) : () => {},
    [selectedId]
  )
  const getSnapshot = useCallback(
    () => (selectedId ? connectionLogStore.get(selectedId) : EMPTY_ENTRIES),
    [selectedId]
  )
  const entries = useSyncExternalStore(subscribe, getSnapshot)
  const diagnosis = selected
    ? diagnoseConnection({ endpoint: selected.endpoint, state, activePath, pendingPath, entries })
    : null

  const copyDiagnostics = useCallback(async () => {
    if (!selected) {
      return
    }
    const desktopAppVersion = liveDesktopAppVersion ?? (await loadHostAppVersion(selected.id))
    const report = buildConnectionDiagnosticsReport({
      hostName: selected.name,
      endpoint: selected.endpoint,
      state,
      reconnectAttempts,
      lastConnectedAt,
      platform: `${Platform.OS} ${Platform.Version ?? ''}`.trim(),
      appVersion: Constants.expoConfig?.version ?? 'unknown',
      desktopAppVersion,
      entries,
      activePath,
      pendingPath
    })
    await Clipboard.setStringAsync(report)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [
    selected,
    state,
    reconnectAttempts,
    lastConnectedAt,
    entries,
    activePath,
    pendingPath,
    liveDesktopAppVersion
  ])

  const sendDiagnostics = useCallback(async () => {
    if (!selected || submissionState === 'sending' || diagnosis?.reportability !== 'orca-relay') {
      return
    }
    setSubmissionState('sending')
    const appVersion = Constants.expoConfig?.version ?? 'unknown'
    const platform = `${Platform.OS} ${Platform.Version ?? ''}`.trim()
    const desktopAppVersion = liveDesktopAppVersion ?? (await loadHostAppVersion(selected.id))
    const report = buildConnectionDiagnosticsReport({
      hostName: selected.name,
      endpoint: selected.endpoint,
      state,
      reconnectAttempts,
      lastConnectedAt,
      platform,
      appVersion,
      desktopAppVersion,
      entries,
      activePath,
      pendingPath
    })
    const result = await submitConnectionDiagnostics({ report, appVersion, platform })
    setSubmissionState(result.ok ? 'sent' : 'failed')
  }, [
    selected,
    submissionState,
    state,
    reconnectAttempts,
    lastConnectedAt,
    entries,
    activePath,
    pendingPath,
    liveDesktopAppVersion,
    diagnosis
  ])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Network diagnostics</Text>
      </View>

      {hosts.length > 1 && (
        <View style={styles.hostPicker}>
          {hosts.map((host) => (
            <Pressable
              key={host.id}
              style={[styles.hostChip, host.id === selectedId && styles.hostChipActive]}
              onPress={() => setSelectedId(host.id)}
            >
              <Text
                style={[styles.hostChipText, host.id === selectedId && styles.hostChipTextActive]}
                numberOfLines={1}
              >
                {host.name}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {selected ? (
        <>
          <View style={styles.statusRow}>
            <Text style={styles.statusText}>
              {state}
              {reconnectAttempts > 0 ? ` · attempt ${reconnectAttempts}` : ''}
            </Text>
            <Pressable style={styles.copyButton} onPress={() => void copyDiagnostics()}>
              {copied ? (
                <Check size={14} color={colors.statusGreen} />
              ) : (
                <Copy size={14} color={colors.textSecondary} />
              )}
              <Text style={styles.copyButtonText}>{copied ? 'Copied' : 'Copy report'}</Text>
            </Pressable>
          </View>
          {diagnosis && (
            <View style={styles.diagnosisCard}>
              <Text style={styles.diagnosisHeading}>What this suggests</Text>
              <Text style={styles.diagnosisText}>{diagnosis.likelyCause}</Text>
              <Text style={styles.diagnosisNext}>{diagnosis.nextStep}</Text>
              {diagnosis.reportability === 'orca-relay' && (
                <>
                  <Text style={styles.privacyHint}>
                    Sends redacted connection events only—never terminal contents or credentials.
                  </Text>
                  <Pressable
                    style={styles.sendButton}
                    onPress={() => void sendDiagnostics()}
                    disabled={submissionState === 'sending'}
                  >
                    {submissionState === 'sent' ? (
                      <Check size={14} color={colors.statusGreen} />
                    ) : (
                      <Send size={14} color={colors.textPrimary} />
                    )}
                    <Text style={styles.sendButtonText}>
                      {submissionState === 'sending'
                        ? 'Sending…'
                        : submissionState === 'sent'
                          ? 'Diagnostics sent'
                          : submissionState === 'failed'
                            ? 'Retry sending'
                            : 'Send diagnostics to Orca'}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          )}
          {entries.length > 0 ? (
            <ConnectionLog entries={[...entries]} title={selected.name} fillAvailableHeight />
          ) : (
            <Text style={styles.emptyText}>
              No connection events yet. Events appear as the app dials this host.
            </Text>
          )}
        </>
      ) : (
        <Text style={styles.emptyText}>No paired hosts.</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  hostPicker: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  hostChip: {
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: 16,
    backgroundColor: colors.bgRaised
  },
  hostChipActive: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  hostChipText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    maxWidth: 160
  },
  hostChipTextActive: {
    color: colors.textPrimary,
    fontWeight: '600'
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm
  },
  statusText: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  diagnosisCard: {
    backgroundColor: colors.bgPanel,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: 10,
    padding: spacing.md,
    marginBottom: spacing.md
  },
  diagnosisHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary,
    marginBottom: spacing.xs
  },
  diagnosisText: {
    fontSize: typography.metaSize,
    color: colors.textPrimary,
    lineHeight: 18
  },
  diagnosisNext: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    lineHeight: 18,
    marginTop: spacing.xs
  },
  privacyHint: {
    marginTop: spacing.sm,
    fontSize: 11,
    lineHeight: 15,
    color: colors.textMuted
  },
  sendButton: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  sendButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderRadius: 8,
    backgroundColor: colors.bgRaised
  },
  copyButtonText: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  emptyText: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
})
