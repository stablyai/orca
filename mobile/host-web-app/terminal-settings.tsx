import { useMemo } from 'react'
import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import TerminalSettingsScreen from '../src/terminal/terminal-settings-screen'
import {
  webTerminalSettingsHost,
  webTerminalSettingsOperations
} from '../src/terminal/web-terminal-settings-operations'

export default function HostedTerminalSettingsRoute() {
  const shell = useMobileWebNativeShell()
  return <HostedTerminalSettings key={shell.context?.shellSessionId ?? 'pending'} />
}
function HostedTerminalSettings() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const client = shell.client
  const operations = useMemo(
    () => (client ? webTerminalSettingsOperations(client) : null),
    [client]
  )
  const hosts = useMemo(() => (client ? [webTerminalSettingsHost(client)] : []), [client])
  const onBack = () => {
    if (router.canGoBack()) {
      router.back()
    } else {
      router.replace('/settings')
    }
  }
  if (!client || !operations) {
    return null
  }
  return (
    <TerminalSettingsScreen scope="host" hosts={hosts} operations={operations} onBack={onBack} />
  )
}
