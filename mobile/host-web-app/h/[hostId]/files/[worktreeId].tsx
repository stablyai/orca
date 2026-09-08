import { useMemo } from 'react'
import { MobileFileExplorerScreen } from '../../../../app/h/[hostId]/files/[worktreeId]'
import { useMobileWebNativeShell } from '../../../../../src/mobile-web/src/native-shell-channel'
import { webHostFileExplorerOperations } from '../../../../src/files/web-host-file-explorer-operations'

export default function HostMobileWebFileExplorerRoute() {
  const shell = useMobileWebNativeShell()
  const operations = useMemo(
    () => (shell.client ? webHostFileExplorerOperations(shell.client) : undefined),
    [shell.client]
  )

  return (
    <MobileFileExplorerScreen
      operations={operations}
      connectionState={shell.connection}
      nativeHostBinding={false}
    />
  )
}
