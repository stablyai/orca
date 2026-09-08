import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import { loadHosts } from '../src/transport/host-store'
import { useHostClient, useRpcClientContext } from '../src/transport/client-context'
import { useHostStatusGates } from '../src/transport/host-status-gates'
import { ConnectionDiagnosticsScreen } from '../src/diagnostics/connection-diagnostics-screen'
import { createNativeDiagnosticsOperations } from '../src/diagnostics/native-diagnostics-operations'
import {
  resolveDiagnosticsHostId,
  type DiagnosticsHostSelection
} from '../src/diagnostics/connection-diagnostics-screen-data'
import { connectionDiagnosticsScreenStyles as styles } from '../src/diagnostics/connection-diagnostics-screen-styles'
import type { HostProfile } from '../src/transport/types'

// Why: reading the log is most needed while a host is failing, so this
// screen also *acquires* the host client — opening it kicks a dial and the
// log fills live instead of showing a stale tail.
export default function ConnectionLogScreen() {
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
  // Why: refreshes the persisted desktop version the diagnostics report reads back.
  useHostStatusGates({ hostId: selected?.id, client, connState: state })
  const device = useMemo(
    () => (selected ? createNativeDiagnosticsOperations(selected, clientContext) : null),
    [selected, clientContext]
  )
  const select = useCallback(
    (hostId: string) => setManualSelection({ hostId, requestedHostId: params.hostId, routeKey }),
    [params.hostId, routeKey]
  )

  return (
    <ConnectionDiagnosticsScreen
      key={selectedId ?? 'none'}
      device={device}
      hostName={selected?.name ?? null}
      writeClipboard={(report) => Clipboard.setStringAsync(report)}
      onBack={() => router.back()}
      hostPicker={
        hosts.length > 1 ? (
          <View style={styles.hostPicker}>
            {hosts.map((host) => (
              <Pressable
                key={host.id}
                style={[styles.hostChip, host.id === selectedId && styles.hostChipActive]}
                onPress={() => select(host.id)}
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
