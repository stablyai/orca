import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { loadHosts, peekHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import VoiceSettingsScreen from '../src/settings/voice-settings-screen'
import { nativeVoiceSettingsOperations } from '../src/settings/native-voice-settings-operations'

export default function NativeVoiceSettingsRoute() {
  const router = useRouter()
  // Null until the first read, so a paired phone never flashes "connect a desktop".
  const [hosts, setHosts] = useState<HostProfile[] | null>(() => peekHosts())
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => (hosts ?? []).map((host) => host.id), [hosts])
  const { clients, focused } = useFocusedSettingsHostClients(hostIds)
  const connected = clients.find((entry) => entry.state === 'connected')
  const client = connected?.client ?? null
  const connecting =
    !connected &&
    (hosts === null ||
      (hosts.length > 0 &&
        (clients.length === 0 ||
          clients.some(
            (entry) => entry.state !== 'disconnected' && entry.state !== 'auth-failed'
          ))))
  // Keep the last desktop through reconnects; a different desktop remounts the screen.
  const [screenHostId, setScreenHostId] = useState(connected?.hostId)
  if (connected && connected.hostId !== screenHostId) {
    setScreenHostId(connected.hostId)
  }
  const operations = useMemo(
    () => (client ? nativeVoiceSettingsOperations(client) : null),
    [client]
  )
  return (
    // Remount per desktop so a late reply from the previous one cannot land on this screen.
    <VoiceSettingsScreen
      key={screenHostId}
      operations={operations}
      connecting={connecting}
      focused={focused}
      onBack={() => router.back()}
    />
  )
}
