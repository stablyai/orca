import { useEffect, useState } from 'react'
import { loadHosts, peekHosts } from '../host-catalog/host-store'

/** The paired host's name, as the host list knows it; empty until it's read. */
export function useMcpHostName(hostId: string): string {
  const [name, setName] = useState(
    () => peekHosts()?.find((host) => host.id === hostId)?.name ?? ''
  )
  useEffect(() => {
    let live = true
    void loadHosts().then((hosts) => {
      const host = hosts.find((entry) => entry.id === hostId)
      if (live && host) {
        setName(host.name)
      }
    })
    return () => {
      live = false
    }
  }, [hostId])
  return name
}
