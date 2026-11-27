import { useRouter } from 'expo-router'
import { MobileWebBundleProbeRow } from '../src/diagnostics/mobile-web-bundle-probe-row'
import { MobileWebShellUpdateFailureRow } from '../src/diagnostics/mobile-web-shell-update-failure-row'
import { TroubleshootView } from '../src/diagnostics/troubleshoot-view'
import { useTroubleshootDiagnostics } from '../src/diagnostics/use-troubleshoot-diagnostics'
import { isWatchActionSpikeEnabled } from '../src/watch-action-spike/watch-action-spike-config'
import { WatchActionSpikeRow } from '../src/watch-action-spike/WatchActionSpikeRow'
import { isSiriEnabled } from '../src/siri/siri-config'
import { SiriSetupRow } from '../src/siri/SiriSetupRow'

// Guard __DEV__ outside RN. Static import keeps graph/schemas in release, but mounts no row and makes no host lookup/request.
// Trimming it needs shell support for conditional imports; existing mobile require calls are Metro assets.
const isDevelopmentBuild = typeof __DEV__ !== 'undefined' && __DEV__

export default function NativeTroubleshootRoute() {
  const router = useRouter()
  const { rootRef, diagnosticStatus, checks, hostEndpoints, runDiagnostics } =
    useTroubleshootDiagnostics()
  return (
    <TroubleshootView
      rootRef={rootRef}
      diagnosticStatus={diagnosticStatus}
      checks={checks}
      hostEndpoints={hostEndpoints}
      runDiagnostics={() => void runDiagnostics()}
      onBack={() => router.back()}
      onConnectionLog={() => router.push('/connection-log')}
      onIssue={(id) => router.push({ pathname: '/troubleshoot-issue', params: { id } })}
      developerRow={
        // The bundle probe stays development-only: it fetches.
        <>
          {isWatchActionSpikeEnabled() ? <WatchActionSpikeRow /> : null}
          {isSiriEnabled() ? <SiriSetupRow /> : null}
          {isDevelopmentBuild ? <MobileWebBundleProbeRow /> : null}
          <MobileWebShellUpdateFailureRow />
        </>
      }
    />
  )
}
