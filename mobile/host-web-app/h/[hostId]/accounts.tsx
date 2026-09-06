import { useMemo } from 'react'
import { AccountsScreen } from '../../../app/h/[hostId]/accounts'
import { useMobileWebNativeShell } from '../../../../src/mobile-web/src/native-shell-channel'
import { webHostAccountsOperations } from '../../../src/accounts/web-host-accounts-operations'

const HOSTED_PAGE_HOST_ID = 'paired-orca-desktop'

export default function HostMobileWebAccountsRoute() {
  const shell = useMobileWebNativeShell()
  const operations = useMemo(
    () =>
      shell.client
        ? webHostAccountsOperations(shell.client, shell.hostDisplayName ?? 'Orca Desktop')
        : undefined,
    [shell.client, shell.hostDisplayName]
  )
  const connectionState =
    shell.connection === 'offline'
      ? 'disconnected'
      : shell.connection === 'recovering'
        ? 'reconnecting'
        : shell.connection

  return (
    <AccountsScreen
      hostId={HOSTED_PAGE_HOST_ID}
      operations={operations}
      connectionState={connectionState}
      nativeHostBinding={false}
    />
  )
}
