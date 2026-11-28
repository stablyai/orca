import { useEffect, useState } from 'react'
import { loadHosts, peekHosts } from '../host-catalog/host-store'

/** The paired host's name, from the host list already read, else read once; empty for no host. */
export function useMcpHostName(hostId: string): string {
  const known = hostId ? peekHosts()?.find((host) => host.id === hostId)?.name : undefined
  const [loaded, setLoaded] = useState<{ id: string; name: string } | null>(null)
  useEffect(() => {
    if (!hostId || known !== undefined) {
      return undefined
    }
    let live = true
    void loadHosts().then((hosts) => {
      const host = hosts.find((entry) => entry.id === hostId)
      if (live && host) {
        setLoaded({ id: hostId, name: host.name })
      }
    })
    return () => {
      live = false
    }
  }, [hostId, known])
  return known ?? (loaded?.id === hostId ? loaded.name : '')
}
