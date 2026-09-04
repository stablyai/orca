import { useEffect, useRef, useState } from 'react'
import { loadHostCatalog } from '../transport/host-store'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import { useAllHostClients } from '../transport/use-all-host-clients'
import { NOTIFICATIONS_REMOTE_PUSH_CAPABILITY } from './push-registration'

export type RemotePushHostSupport = {
  /** At least one paired host advertises `notifications.remote-push.v1`. */
  supported: boolean
  /** Whether the answer above is final rather than "nobody has replied yet". */
  resolved: boolean
}

/**
 * Whether background push can be offered at all. The desktop advertises the
 * capability in `status.get`, so the answer needs a connected host — until one
 * replies the screen must stay silent rather than tell someone to update a
 * desktop that is already current.
 */
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
      // Why nothing on failure: an unread catalog marked loaded resolves the answer as
      // "no paired host supports push", which tells the user to update a current desktop.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const clients = useAllHostClients(hostIds)

  // Why pruned rather than left: an answer for a host that is no longer paired is a
  // vote from a desktop this phone cannot receive a push from.
  useEffect(() => {
    setSupportedByHostId((previous) => {
      const kept = Object.entries(previous).filter(([hostId]) => hostIds.includes(hostId))
      return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept)
    })
  }, [hostIds])

  // Why diffed by client identity rather than restarted on every `clients` value:
  // useAllHostClients rebuilds the array on each connection tick, so a plain
  // dependency tears down and re-runs every host's probe whenever any host moves.
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
    supported: answeredHostIds.some((hostId) => supportedByHostId[hostId] === true),
    // A connected host that has not answered yet is exactly the case the silence is
    // for, so one outstanding probe holds the whole section back. Disconnected hosts
    // do not: their earlier answer stands, and one that never answered never will.
    resolved:
      (hostsLoaded && hostIds.length === 0) ||
      (answeredHostIds.length > 0 &&
        clients.every((entry) => entry.state !== 'connected' || entry.hostId in supportedByHostId))
  }
}
