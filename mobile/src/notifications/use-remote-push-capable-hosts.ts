import { useEffect, useRef, useState } from 'react'
import { loadHostCatalog } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { NOTIFICATIONS_REMOTE_PUSH_CAPABILITY } from './push-registration'

export type RemotePushHostSupport = {
  supported: boolean
  // False while a connected host’s capability remains unanswered.
  resolved: boolean
}

// Wait for status replies before offering push or an update prompt; silence cannot prove a current desktop lacks support.
export function useRemotePushCapableHosts(): RemotePushHostSupport {
  const [hostIds, setHostIds] = useState<string[]>([])
  const [hostsLoaded, setHostsLoaded] = useState(false)
  const [supportedByHostId, setSupportedByHostId] = useState<Record<string, boolean>>({})
  const probesRef = useRef(new Map<string, { client: RpcClient; stop: () => void }>())

  useEffect(() => {
    let cancelled = false
    void loadHostCatalog()
      .then((hosts) => {
        if (!cancelled) {
          setHostIds(hosts.map((host) => host.id))
          setHostsLoaded(true)
        }
      })
      // Unread catalog is unresolved, not evidence every paired desktop lacks push.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const clients = useAllHostClients(hostIds)

  // Remove votes from unpaired hosts because their pushes cannot reach this phone.
  useEffect(() => {
    setSupportedByHostId((previous) => {
      const kept = Object.entries(previous).filter(([hostId]) => hostIds.includes(hostId))
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept)
    })
  }, [hostIds])

  // Diff client identities: useAllHostClients rebuilds its array on every tick, which must not restart unchanged probes.
  useEffect(() => {
    const connected = new Map(
      clients
        .filter((entry) => entry.state === 'connected')
        .map((entry) => [entry.hostId, entry.client])
    )
    const probes = probesRef.current
    for (const [hostId, probe] of probes) {
      if (connected.get(hostId) !== probe.client) {
        probe.stop()
        probes.delete(hostId)
      }
    }
    for (const [hostId, client] of connected) {
      if (!probes.has(hostId)) {
        setSupportedByHostId((previous) => {
          const { [hostId]: _removed, ...remaining } = previous
          return remaining
        })
        const stop = startRuntimeCapabilityProbe(client, (capabilities) => {
          setSupportedByHostId((previous) => ({
            ...previous,
            [hostId]: capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
          }))
        })
        probes.set(hostId, { client, stop })
      }
    }
  }, [clients])

  useEffect(() => {
    const probes = probesRef.current
    return () => {
      for (const probe of probes.values()) {
        probe.stop()
      }
      probes.clear()
    }
  }, [])

  const answeredHostIds = hostIds.filter((hostId) => hostId in supportedByHostId)
  return {
    supported: answeredHostIds.some((hostId) => supportedByHostId[hostId]),
    // Outstanding connected probes keep the section unresolved; disconnected hosts retain prior answers without waiting forever for missing ones.
    resolved:
      (hostsLoaded && hostIds.length === 0) ||
      (answeredHostIds.length > 0 &&
        clients.every((entry) => entry.state !== 'connected' || entry.hostId in supportedByHostId))
  }
}
