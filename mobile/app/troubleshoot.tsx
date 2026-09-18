import { useRouter } from 'expo-router'
import { MobileWebBundleProbeRow } from '../src/diagnostics/mobile-web-bundle-probe-row'
import { TroubleshootView } from '../src/diagnostics/troubleshoot-view'
import { useTroubleshootDiagnostics } from '../src/diagnostics/use-troubleshoot-diagnostics'

// Same guard as push-token.ts: `__DEV__` is undefined outside the React Native runtime. The import
// above is static, so a release bundle still carries the row's graph and evaluates its hoisted
// schemas at load; nothing mounts, no host is looked up and no request is made. This repo has no
// `__DEV__`-conditional `require` idiom to trim it with — every `require` in `mobile/src` is a Metro
// asset path — so introducing one is a change for the shell in Phase B, not for this row.
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
