import { useMemo } from 'react'
import { MobileFilePreviewRoute } from '../../../../../app/h/[hostId]/files/preview/[worktreeId]'
import { useMobileWebNativeShell } from '../../../../../../src/mobile-web/src/native-shell-channel'
import { webHostFilePreviewOperations } from '../../../../../src/files/web-host-file-preview-operations'

export default function HostMobileWebFilePreviewRoute() {
  const shell = useMobileWebNativeShell()
  const operations = useMemo(
    () => (shell.client ? webHostFilePreviewOperations(shell.client) : undefined),
    [shell.client]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

  return (
    <MobileFilePreviewRoute
      operations={operations}
      connectionState={connectionState}
      nativeHostBinding={false}
    />
  )
}
