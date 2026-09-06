import { useMemo } from 'react'
import { usePathname, useRouter } from 'expo-router'
import { HostScreen } from '../app/h/[hostId]/index'
import { HostProtocolGatesProvider } from '../src/components/host-protocol-gates-context'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { webHostWorkspaceOperations } from '../src/worktree/web-host-workspace-operations'
import { webHostWorkspaceCreationOperations } from '../src/worktree/web-host-workspace-creation-operations'
import { webHostScreenHostState } from '../src/worktree/web-host-screen-host-state'
import { navigateFromHostScreenList } from '../src/worktree/host-screen-route-navigation'
import { webHostScreenShellOperations } from '../src/worktree/web-host-screen-shell-operations'
import { useWebHostStatusGates } from '../src/transport/web-host-status-gates'

const HOSTED_PAGE_HOST_ID = 'paired-orca-desktop'

export default function HostMobileWebRoute() {
  const shell = useMobileWebNativeShell()
  const router = useRouter()
  const pathname = usePathname()
  const workspaceOperations = useMemo(
    () => (shell.client ? webHostWorkspaceOperations(shell.client) : undefined),
    [shell.client]
  )
  const workspaceCreationOperations = useMemo(
    () => (shell.client ? webHostWorkspaceCreationOperations(shell.client) : undefined),
    [shell.client]
  )
  const hostState = useMemo(
    () =>
      webHostScreenHostState({
        name: shell.hostDisplayName ?? 'Orca Desktop',
        publicKeyB64: ''
      }),
    [shell.hostDisplayName]
  )
  const shellOperations = useMemo(
    () =>
      webHostScreenShellOperations(shell.client, (target) =>
        navigateFromHostScreenList({
          router,
          pathname,
          target,
          embedded: false,
          hostId: HOSTED_PAGE_HOST_ID
        })
      ),
    [pathname, router, shell.client]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection
  const hostStatusGates = useWebHostStatusGates({
    client: shell.client,
    connection: shell.connection
  })
  return (
    <HostProtocolGatesProvider value={hostStatusGates}>
      <HostScreen
        hostId={HOSTED_PAGE_HOST_ID}
        nativeHostBinding={false}
        connectionState={connectionState}
        connectionMetrics={{
          reconnectAttempts: shell.reconnectAttempts,
          lastConnectedAt: shell.lastConnectedAt
        }}
        workspaceOperations={workspaceOperations}
        workspaceCreationOperations={workspaceCreationOperations}
        hostState={hostState}
        shellOperations={shellOperations}
      />
    </HostProtocolGatesProvider>
  )
}
