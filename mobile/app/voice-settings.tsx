import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import { useRpcClientContext } from '../src/transport/client-context'
import VoiceSettingsScreen, {
  type VoiceSettingsConnection
} from '../src/settings/voice-settings-screen'
import { nativeVoiceSettingsOperations } from '../src/settings/native-voice-settings-operations'

const DIALING_STATES = new Set(['connecting', 'handshaking', 'reconnecting'])

export default function NativeVoiceSettingsRoute() {
  const router = useRouter()
  const { forceReconnect } = useRpcClientContext()
  const [hosts, setHosts] = useState<HostProfile[] | null>(null)
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => (hosts ?? []).map((host) => host.id), [hosts])
  const { clients, focused } = useFocusedSettingsHostClients(hostIds)
  const client = clients.find((entry) => entry.state === 'connected')?.client ?? null
  const operations = useMemo(
    () => (client ? nativeVoiceSettingsOperations(client) : null),
    [client]
  )
  // Only read while no desktop is connected: says whether one is on its way or which one is down.
  const connection = useMemo((): VoiceSettingsConnection => {
    if (hosts !== null && hosts.length === 0) {
      return { kind: 'no-desktop' }
    }
    const dialing = clients.find((entry) => DIALING_STATES.has(entry.state))
    const nameOf = (hostId: string | undefined) => hosts?.find((host) => host.id === hostId)?.name
    if (hosts === null || !focused || clients.length === 0 || dialing) {
      return { kind: 'connecting', desktopName: nameOf(dialing?.hostId ?? hostIds[0]) }
    }
    return {
      kind: 'offline',
      desktopName: hostIds.length === 1 ? nameOf(hostIds[0]) : undefined,
      onRetry: forceReconnect
        ? () => {
            for (const hostId of hostIds) {
              void forceReconnect(hostId)
            }
          }
        : undefined
    }
  }, [clients, focused, forceReconnect, hostIds, hosts])
  return (
    <VoiceSettingsScreen
      operations={operations}
      focused={focused}
      connection={connection}
      onBack={() => router.back()}
    />
  )
}
