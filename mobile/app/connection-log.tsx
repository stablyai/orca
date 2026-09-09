import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { loadHosts } from '../src/transport/host-store'
import { connectionLogStore } from '../src/transport/persisted-connection-log-store'
import { useHostClient, useRpcClientContext } from '../src/transport/client-context'
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
import type { ConnectionLogEntry, HostProfile } from '../src/transport/types'

// Why: getSnapshot must be referentially stable when there's no data —
// a fresh [] per call would make useSyncExternalStore re-render forever.
const EMPTY_ENTRIES: readonly ConnectionLogEntry[] = []

// Why: reading the log is most needed while a host is failing, so this
// route also *acquires* the host client — opening it kicks a dial and the
// log fills live instead of showing a stale tail.
export default function NativeConnectionLogRoute() {
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
  const { desktopAppVersion } = useHostStatusGates({
    hostId: selected?.id,
    client,
    connState: state
  })
  const reconnectAttempts = useReconnectAttempt(selected?.id)
  const { activePath, pendingPath } = useConnectionPathStatus(selected?.id)

  useEffect(() => {
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
  const entries = useSyncExternalStore(subscribe, getSnapshot)
  const device = useMemo(
    () =>
      selected
        ? createNativeDiagnosticsOperations(selected, clientContext, desktopAppVersion)
        : null,
    [selected, clientContext, desktopAppVersion]
  )

  return (
    <ConnectionDiagnosticsScreen
      device={device}
      hostId={selected?.id ?? null}
      hostName={selected?.name ?? null}
      endpoint={selected?.endpoint ?? null}
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
