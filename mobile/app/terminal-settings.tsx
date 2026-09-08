import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import { nativeTerminalSettingsOperations } from '../src/terminal/terminal-settings-operations'
import { nativeTerminalSettingsHost } from '../src/terminal/native-terminal-settings-host'
import TerminalSettingsScreen from '../src/terminal/terminal-settings-screen'

export default function NativeTerminalSettingsRoute() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    let active = true
    void loadHosts().then((next) => {
      if (active) {
        setHosts(next)
      }
    })
    return () => {
      active = false
    }
  }, [])
  const hostIds = useMemo(() => hosts.map((host) => host.id), [hosts])
  const { clients } = useFocusedSettingsHostClients(hostIds)
  const settingsHosts = useMemo(
    () =>
      hosts.map((host) =>
        nativeTerminalSettingsHost(
          host,
          clients.find((entry) => entry.hostId === host.id)?.client ?? null
        )
      ),
    [hosts, clients]
  )
  return (
    <TerminalSettingsScreen
      hosts={settingsHosts}
      operations={nativeTerminalSettingsOperations}
      onBack={() => router.back()}
    />
  )
}
