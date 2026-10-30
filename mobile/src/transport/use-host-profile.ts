import { useEffect, useState } from 'react'
import { loadHosts } from './host-store'
import type { HostProfile } from './types'

/** The stored profile for a paired host; null while loading or when unknown. */
export function useHostProfile(hostId: string): HostProfile | null {
  const [host, setHost] = useState<HostProfile | null>(null)
  useEffect(() => {
    let stale = false
    setHost(null)
    loadHosts().then(
      (hosts) => {
        if (!stale) {
          setHost(hosts.find((profile) => profile.id === hostId) ?? null)
        }
      },
      () => {}
    )
    return () => {
      stale = true
    }
  }, [hostId])
  return host
}
