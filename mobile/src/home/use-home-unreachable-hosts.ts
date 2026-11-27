import { useMemo } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  homeUnreachableHostIds,
  type HomeHostConnectionInputs
} from './home-host-connection-projection'

export function useHomeUnreachableHosts(
  hosts: readonly { id: string; name: string; endpoint: string }[],
  inputs: HomeHostConnectionInputs,
  now: number
): ReadonlySet<string> {
  const t = useMobileTranslation()
  const { autoConnectHostIds, hostAttempts, hostConnections, hostLastConnected, hostStates } =
    inputs
  // Keyed by its members, so a retry that moves no desktop in or out keeps Home's rows as they are.
  const unreachableKey = useMemo(
    () =>
      homeUnreachableHostIds(
        hosts,
        { autoConnectHostIds, hostAttempts, hostConnections, hostLastConnected, hostStates },
        now,
        t
      ).join('\n'),
    [
      hosts,
      autoConnectHostIds,
      hostAttempts,
      hostConnections,
      hostLastConnected,
      hostStates,
      now,
      t
    ]
  )
  return useMemo(() => new Set(unreachableKey ? unreachableKey.split('\n') : []), [unreachableKey])
}
