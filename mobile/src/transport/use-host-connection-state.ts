import { useEffect, useState } from 'react'
import type { ConnectionState, HostProfile } from './transport/types'
import type { RpcClient } from './transport/rpc-client'

export type HostClientEntry = { hostId: string; client: RpcClient }

// Why (#6784 + connection-state mirroring): extracted from HomeScreen so that
// file stays under its max-lines budget. Mirrors each host's live connection
// state (state/attempts/lastConnected/last socket error) into React state so
// the home verdict + status dots keep working. Logic is unchanged from the
// original inline effect.
export function useHostConnectionState(args: {
  allClients: HostClientEntry[]
  hosts: HostProfile[]
}): {
  hostStates: Record<string, ConnectionState>
  hostAttempts: Record<string, number>
  hostLastConnected: Record<string, number | null>
  hostConnErrors: Record<string, string | null>
} {
  const { allClients, hosts } = args
  const [hostStates, setHostStates] = useState<Record<string, ConnectionState>>({})
  const [hostAttempts, setHostAttempts] = useState<Record<string, number>>({})
  const [hostLastConnected, setHostLastConnected] = useState<Record<string, number | null>>({})
  const [hostConnErrors, setHostConnErrors] = useState<Record<string, string | null>>({})

  // Why: mirror per-host connection state into hostStates so existing
  // render code (status dots, connecting indicators) keeps working.
  useEffect(() => {
    setHostAttempts((prev) => {
      const next: Record<string, number> = { ...prev }
      let changed = false
      for (const entry of allClients) {
        const a = entry.client.getReconnectAttempt()
        if (next[entry.hostId] !== a) {
          next[entry.hostId] = a
          changed = true
        }
      }
      return changed ? next : prev
    })
    setHostLastConnected((prev) => {
      const next: Record<string, number | null> = { ...prev }
      let changed = false
      for (const entry of allClients) {
        const t = entry.client.getLastConnectedAt()
        if (next[entry.hostId] !== t) {
          next[entry.hostId] = t
          changed = true
        }
      }
      return changed ? next : prev
    })
    // Why (#6784): mirror the real socket error so the home verdict shows it.
    setHostConnErrors((prev) => {
      const next: Record<string, string | null> = { ...prev }
      let changed = false
      for (const entry of allClients) {
        const err = entry.client.getLastConnectionError()
        if (next[entry.hostId] !== err) {
          next[entry.hostId] = err
          changed = true
        }
      }
      return changed ? next : prev
    })
    setHostStates((prev) => {
      const next: Record<string, ConnectionState> = { ...prev }
      let changed = false
      const liveIds = new Set(allClients.map((e) => e.hostId))
      for (const entry of allClients) {
        if (next[entry.hostId] !== entry.state) {
          next[entry.hostId] = entry.state
          changed = true
        }
      }
      // Why: when a paired host disappears from allClients (because the
      // user tapped Disconnect, or the host record was invalid) the card
      // must reflect that. We only force-update hosts whose state was
      // already tracked — otherwise the initial-acquire frame (entry not
      // yet materialised) would briefly flip every host to 'disconnected'.
      for (const host of hosts) {
        if (liveIds.has(host.id)) {
          continue
        }
        if (!host.publicKeyB64 || !host.deviceToken) {
          if (next[host.id] !== 'auth-failed') {
            next[host.id] = 'auth-failed'
            changed = true
          }
          continue
        }
        const prevState = next[host.id]
        if (prevState && prevState !== 'disconnected' && prevState !== 'auth-failed') {
          next[host.id] = 'disconnected'
          changed = true
        }
      }
      // Drop entries for hosts we no longer track at all.
      for (const id of Object.keys(next)) {
        if (!liveIds.has(id) && hosts.some((h) => h.id === id) === false) {
          delete next[id]
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [allClients, hosts])

  return { hostStates, hostAttempts, hostLastConnected, hostConnErrors }
}
