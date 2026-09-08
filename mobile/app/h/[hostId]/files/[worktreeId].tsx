import { MobileFileExplorerPanel } from '../../../../src/files/MobileFileExplorerPanel'
import { useMobileWebRouteParams } from '../../../../src/mobile-web/use-mobile-web-route-params'
import type { HostFileExplorerOperations } from '../../../../src/files/host-file-explorer-operations'
import type { ConnectionState } from '../../../../src/transport/types'

export function MobileFileExplorerScreen({
  operations,
  connectionState,
  nativeHostBinding = true
}: {
  operations?: HostFileExplorerOperations
  connectionState?: ConnectionState
  nativeHostBinding?: boolean
} = {}) {
  const { hostId, worktreeId, name } = useMobileWebRouteParams<{
    hostId: string
    worktreeId: string
    name?: string
  }>()
  return (
    <MobileFileExplorerPanel
      hostId={hostId}
      worktreeId={worktreeId}
      name={name}
      embedded={false}
      operations={operations}
      connectionState={connectionState}
      nativeHostBinding={nativeHostBinding}
    />
  )
}

export default MobileFileExplorerScreen
