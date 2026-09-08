import { useCallback, useEffect, useState } from 'react'
import { usePrimeHosts } from '../transport/client-context'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'

export function useMobileWebHostCatalog(): {
  hosts: HostProfile[]
  hostsLoading: boolean
  hostLoadError: boolean
  refreshHosts: () => Promise<void>
} {
  const [hosts, setHosts] = useState<HostProfile[]>([])
  const [hostsLoading, setHostsLoading] = useState(true)
  const [hostLoadError, setHostLoadError] = useState(false)
  const primeHosts = usePrimeHosts()
  const refreshHosts = useCallback(async () => {
    setHostsLoading(true)
    setHostLoadError(false)
    try {
      setHosts(await loadHosts())
    } catch {
      setHostLoadError(true)
    } finally {
      setHostsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshHosts()
  }, [refreshHosts])

  // Why: avoid a second serialized Keychain read before opening a freshly paired host.
  useEffect(() => {
    if (hosts.length > 0) {
      primeHosts(hosts)
    }
  }, [hosts, primeHosts])

  return { hosts, hostsLoading, hostLoadError, refreshHosts }
}
