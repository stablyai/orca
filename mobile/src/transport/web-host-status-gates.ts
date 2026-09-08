import { useEffect, useState } from 'react'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import type { MobileWebNativeShellState } from '../../../src/mobile-web/src/native-shell-channel'
import type { HostStatusGates } from './host-status-gates'

type LoadedWebHostStatusGates = Omit<HostStatusGates, 'statusPending'> & {
  client: MobileWebBridgeClient
}

const EMPTY_HOST_CAPABILITIES: string[] = []

export function useWebHostStatusGates(args: {
  client: MobileWebBridgeClient | null
  connection: MobileWebNativeShellState['connection']
}): HostStatusGates {
  const { client, connection } = args
  const [loaded, setLoaded] = useState<LoadedWebHostStatusGates | null>(null)
  const [unverified, setUnverified] = useState(false)

  useEffect(() => {
    if (connection !== 'connected' || !client) {
      setUnverified(true)
      return
    }
    let cancelled = false
    const requestClient = client
    void requestClient
      .sessionHostGates({ includeHostGates: true })
      .then((result) => {
        if (!cancelled) {
          setLoaded({
            client: requestClient,
            hostCapabilities: result.hostCapabilities,
            floatingWorkspaceEnabled: result.floatingWorkspaceEnabled,
            desktopAppVersion: null,
            compatVerdict: { kind: 'ok' }
          })
          setUnverified(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded((current) =>
            current?.client === requestClient
              ? current
              : {
                  client: requestClient,
                  hostCapabilities: [],
                  floatingWorkspaceEnabled: false,
                  desktopAppVersion: null,
                  compatVerdict: { kind: 'ok' }
                }
          )
          setUnverified(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, connection])

  const proven = loaded?.client === client ? loaded : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'ok' },
      statusPending: connection === 'connected' && client !== null
    }
  }
  return {
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    statusPending: connection === 'connected' && unverified
  }
}
