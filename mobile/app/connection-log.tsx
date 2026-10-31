import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { loadHosts } from '../src/transport/host-store'
import { connectionLogStore } from '../src/transport/persisted-connection-log-store'
import { useRpcClientContext } from '../src/transport/client-context'
import { useHostClient } from '../src/transport/host-client-hooks'
import {
  useConnectionPathStatus,
  useReconnectAttempt
} from '../src/transport/client-context-connection-metrics'
import { useHostStatusGates } from '../src/transport/host-status-gates'
import { ConnectionDiagnosticsScreen } from '../src/diagnostics/connection-diagnostics-screen'
import { createNativeDiagnosticsOperations } from '../src/diagnostics/native-diagnostics-operations'
import {
  readHydratedConnectionLog,
  resolveDiagnosticsHostId,
  type DiagnosticsHostSelection
} from '../src/diagnostics/connection-diagnostics-screen-data'
import { connectionDiagnosticsScreenStyles as styles } from '../src/diagnostics/connection-diagnostics-screen-styles'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { NATIVE_APP_LOG_ID } from '../src/diagnostics/native-render-log'
import type { ConnectionLogEntry, HostProfile } from '../src/transport/types'

// Keep empty snapshot identity stable or useSyncExternalStore rerenders forever.
const EMPTY_ENTRIES: readonly ConnectionLogEntry[] = []
const subscribeAppLog = (listener: () => void) =>
  connectionLogStore.subscribe(NATIVE_APP_LOG_ID, listener)
const getAppLog = () => connectionLogStore.get(NATIVE_APP_LOG_ID)

// Acquire client here so opening logs during host failure starts dialing and live logging.
export default function NativeConnectionLogRoute() {
  useMobileColorScheme()
  const clientContext = useRpcClientContext()
  const router = useRouter()
  const params = useLocalSearchParams<{ hostId?: string }>()
  const routeKey = useMemo(() => ({}), [params.hostId])
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [manualSelection, setManualSelection] = useState<DiagnosticsHostSelection | null>(null)

  useEffect(() => {
    let stale = false
    void loadHosts().then((loaded) => {
      if (!stale) {
        setHosts(loaded)
      }
    })
    return () => {
      stale = true
    }
  }, [])

  const selectedId = resolveDiagnosticsHostId(hosts, params.hostId, manualSelection, routeKey)
  const selected = hosts.find((host) => host.id === selectedId) ?? null
  const { client, state } = useHostClient(selected?.id)
  const { desktopAppVersion, statusPending } = useHostStatusGates({
    hostId: selected?.id,
    client,
    connState: state
  })
  const reconnectAttempts = useReconnectAttempt(selected?.id)
  const { activePath, pendingPath } = useConnectionPathStatus(selected?.id)

  useEffect(() => {
    void readHydratedConnectionLog(connectionLogStore, NATIVE_APP_LOG_ID)
    if (selectedId) {
      void readHydratedConnectionLog(connectionLogStore, selectedId)
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
  const hostEntries = useSyncExternalStore(subscribe, getSnapshot)
  const appEntries = useSyncExternalStore(subscribeAppLog, getAppLog)
  const entries = useMemo(
    () => [...hostEntries, ...appEntries].sort((a, b) => a.ts - b.ts),
    [hostEntries, appEntries]
  )
  const device = useMemo(
    () =>
      createNativeDiagnosticsOperations(
        selected,
        clientContext,
        statusPending ? null : desktopAppVersion
      ),
    [selected, clientContext, desktopAppVersion, statusPending]
  )

  return (
    <ConnectionDiagnosticsScreen
      device={device}
      host={selected}
      state={state}
      reconnectAttempts={reconnectAttempts}
      activePath={activePath}
      pendingPath={pendingPath}
      entries={entries}
      writeClipboard={(report) => Clipboard.setStringAsync(report)}
      onBack={() => router.back()}
      hostPicker={
        hosts.length > 1 ? (
          <View style={styles.hostPicker}>
            {hosts.map((host) => (
              <Pressable
                key={host.id}
                style={[styles.hostChip, host.id === selectedId && styles.hostChipActive]}
                onPress={() =>
                  setManualSelection({ hostId: host.id, requestedHostId: params.hostId, routeKey })
                }
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
        ) : null
      }
    />
  )
}
