import { useRef, useState } from 'react'
import { hostEndpointLabel } from '../transport/host-endpoint-label'
import type { HostProfile } from '../transport/types'

/** Picker rows for desktops, telling apart two that share a name and endpoint. */
export function hostPickerOptions(hosts: HostProfile[]) {
  const entries = hosts.map((host) => ({
    host,
    endpointLabel: hostEndpointLabel(host.endpoint)
  }))
  const endpointCounts = new Map<string, number>()
  for (const entry of entries) {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    endpointCounts.set(endpointKey, (endpointCounts.get(endpointKey) ?? 0) + 1)
  }
  return entries.map((entry) => {
    const endpointKey = JSON.stringify([entry.host.name, entry.endpointLabel])
    const endpointCollides = (endpointCounts.get(endpointKey) ?? 0) > 1
    const subtitle = endpointCollides
      ? `${entry.endpointLabel} · ${entry.host.id}`
      : entry.endpointLabel
    return { value: entry.host.id, label: entry.host.name, subtitle }
  })
}

/** Runs an action on the only offered host, or on the one picked when several are offered. */
export function useConnectedHostPicker(connectedHosts: HostProfile[]) {
  const [offer, setOffer] = useState<{ hostIds: readonly string[]; open: boolean }>({
    hostIds: [],
    open: false
  })
  const pendingRef = useRef<{ action: (hostId: string) => void; hostId?: string } | null>(null)
  const offeredHosts = connectedHosts.filter((host) => offer.hostIds.includes(host.id))
  const visible = offer.open && offeredHosts.length === offer.hostIds.length
  if (offer.open && !visible) {
    setOffer({ ...offer, open: false })
  }

  function pickHost(action: (hostId: string) => void, hosts: HostProfile[] = connectedHosts) {
    if (hosts.length === 1) {
      action(hosts[0].id)
      return
    }
    if (hosts.length > 1) {
      pendingRef.current = { action }
      setOffer({ hostIds: hosts.map((host) => host.id), open: true })
    }
  }

  function close() {
    setOffer((previous) => ({ ...previous, open: false }))
  }

  function onSelect(hostId: string) {
    if (pendingRef.current) {
      pendingRef.current = { ...pendingRef.current, hostId }
    }
    close()
  }

  function onAfterClose() {
    close()
    const pending = pendingRef.current
    pendingRef.current = null
    const hostId = pending?.hostId
    if (pending && hostId && connectedHosts.some((host) => host.id === hostId)) {
      pending.action(hostId)
    }
  }

  return {
    pickHost,
    pickerProps: {
      visible,
      options: hostPickerOptions(offeredHosts),
      selected: '',
      onSelect,
      onClose: close,
      onAfterClose
    }
  }
}
