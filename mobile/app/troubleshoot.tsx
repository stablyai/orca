import { useRouter } from 'expo-router'
import { TroubleshootView } from '../src/diagnostics/troubleshoot-view'
import { useTroubleshootDiagnostics } from '../src/diagnostics/use-troubleshoot-diagnostics'

export default function NativeTroubleshootRoute() {
  const router = useRouter()
  const { rootRef, diagnosticStatus, checks, runDiagnostics } = useTroubleshootDiagnostics()
  return (
    <TroubleshootView
      rootRef={rootRef}
      diagnosticStatus={diagnosticStatus}
      checks={checks}
      runDiagnostics={() => void runDiagnostics()}
      onBack={() => router.back()}
      onConnectionLog={() => router.push('/connection-log')}
    />
  )
}
