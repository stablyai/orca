import { useEffect, useState } from 'react'
import { loadHostCatalog } from '../transport/host-store'
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

  useEffect(() => {
    let cancelled = false
    void loadHostCatalog()
      .then((hosts) => {
        if (!cancelled) {
          setHostIds(hosts.map((host) => host.id))
          setHostsLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHostsLoaded(true)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clients = useAllHostClients(hostIds)

  useEffect(() => {
    const stopProbes = clients
      .filter((entry) => entry.state === 'connected')
      .map((entry) =>
        startRuntimeCapabilityProbe(entry.client, (capabilities) => {
          setSupportedByHostId((previous) => ({
            ...previous,
            [entry.hostId]: capabilities.includes(NOTIFICATIONS_REMOTE_PUSH_CAPABILITY)
          }))
        })
      )
    return () => {
      for (const stopProbe of stopProbes) {
        stopProbe()
      }
    }
  }, [clients])

  const answers = Object.values(supportedByHostId)
  return {
    supported: answers.some(Boolean),
    // No paired hosts is a final answer too: there is nothing left to hear from.
    resolved: answers.length > 0 || (hostsLoaded && hostIds.length === 0)
  }
}
