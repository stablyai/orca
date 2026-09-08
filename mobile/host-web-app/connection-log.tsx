import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import { ConnectionDiagnosticsScreen } from '../src/diagnostics/connection-diagnostics-screen'

export default function HostedConnectionLogRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  if (!shell.client) {
    return null
  }
  const client = shell.client
  return (
    <ConnectionDiagnosticsScreen
      key={shell.context?.shellSessionId ?? 'pending'}
      device={client.native.diagnosticsDevice}
      hostName="Paired desktop"
      writeClipboard={(report) => client.native.clipboardWrite(report)}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
    />
  )
}
