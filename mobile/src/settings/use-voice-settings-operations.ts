import { useEffect, useMemo, useState } from 'react'
import { loadHosts } from '../transport/host-store'
import type { HostProfile } from '../transport/types'
import { useFocusedSettingsHostClients } from '../transport/settings-host-client-connections'
import { nativeVoiceSettingsOperations } from './native-voice-settings-operations'
import type { VoiceSettingsOperations } from './voice-settings-operations'
import {
  pickVoiceSettingsClient,
  resolveVoiceSettingsHostScope
} from './voice-settings-host-selection'

/** The Voice routes configure `hostId` when given (a session's desktop), else the first connected one. */
export function useVoiceSettingsOperations(hostId?: string): {
  operations: VoiceSettingsOperations | null
  focused: boolean
  /** The named desktop is not paired any more; the screen must not fall back to another one. */
  unpaired: boolean
} {
  // Why: null until loaded, so a named host is never mistaken for an unpaired one mid-load.
  const [hosts, setHosts] = useState<HostProfile[] | null>(null)
  useEffect(() => {
    void loadHosts()
      .catch(() => [])
      .then(setHosts)
  }, [])
  const pairedHostIds = useMemo(() => hosts?.map((host) => host.id) ?? null, [hosts])
  const { hostIds, scopedHostId, unpaired } = useMemo(
    () => resolveVoiceSettingsHostScope(pairedHostIds, hostId),
    [pairedHostIds, hostId]
  )
  const { clients, focused } = useFocusedSettingsHostClients(hostIds)
  const client = pickVoiceSettingsClient(clients, scopedHostId)
  const operations = useMemo(
    () => (client ? nativeVoiceSettingsOperations(client) : null),
    [client]
  )
  return { operations, focused, unpaired }
}
