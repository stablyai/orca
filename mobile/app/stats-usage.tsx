import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'expo-router'
import { loadHosts, peekHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import StatsUsageScreen from '../src/settings/stats-usage-screen'

export default function StatsUsageRoute() {
  const router = useRouter()
  const [hosts, setHosts] = useState<HostProfile[] | null>(() => peekHosts())
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => (hosts ?? []).map((host) => host.id), [hosts])
  const { clients } = useFocusedSettingsHostClients(hostIds)
  const client = clients.find((entry) => entry.state === 'connected')?.client ?? null
  return <StatsUsageScreen client={client} onBack={() => router.back()} />
}
