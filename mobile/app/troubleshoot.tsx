import { useRouter } from 'expo-router'
import { MobileWebBundleProbeRow } from '../src/diagnostics/mobile-web-bundle-probe-row'
import { TroubleshootView } from '../src/diagnostics/troubleshoot-view'
import { useTroubleshootDiagnostics } from '../src/diagnostics/use-troubleshoot-diagnostics'

// Same guard as push-token.ts: `__DEV__` is undefined outside the React Native runtime.
const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__

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
      developerRow={isDevelopmentBuild ? <MobileWebBundleProbeRow /> : null}
    />
  )
}
