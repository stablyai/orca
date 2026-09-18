import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Package } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { useHostClient } from '../transport/client-context'
import { colors } from '../theme/mobile-theme'
import { selectDiagnosticsHostId } from './connection-diagnostics-screen-data'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import {
  useMobileWebBundleProbe,
  type MobileWebBundleProbeState
} from './use-mobile-web-bundle-probe'
import type { HostProfile } from '../transport/types'

/** One `label — detail` line in the same row shape the diagnostic checks use. */
function ProbeLine({ label, detail, failed }: { label: string; detail: string; failed?: boolean }) {
  return (
    <View style={styles.checkRow}>
      <Text style={styles.checkLabel}>{label}</Text>
      <Text style={[styles.checkDetail, failed === true && styles.checkDetailFail]}>{detail}</Text>
    </View>
  )
}

function ProbeResult({ state }: { state: MobileWebBundleProbeState }) {
  if (state.status === 'idle' || state.status === 'running') {
    return null
  }
  if (state.status === 'failed') {
    return (
      <View style={styles.section}>
        <ProbeLine label="Bundle" detail={state.detail} failed />
      </View>
    )
  }
  return (
    <View style={styles.section}>
      <ProbeLine label="Build" detail={state.buildId.slice(0, 12)} />
      <View style={styles.separator} />
      <ProbeLine label="Assets" detail={`${state.assetCount}`} />
      <View style={styles.separator} />
      <ProbeLine label="Bytes" detail={`${state.totalBytes}`} />
      <View style={styles.separator} />
      <ProbeLine label="Elapsed" detail={`${state.elapsedMs} ms`} />
    </View>
  )
}

/**
 * Development-only: fetches the whole mobile web bundle from the paired desktop and reports what
 * came back. Phase A ships no production path that renders a bundle, and this row is the only thing
 * that exercises the operations end to end on a device.
 *
 * `app/troubleshoot.tsx` mounts it behind `__DEV__`, so a shipped build never runs the host lookup
 * or acquires a client on this screen.
 */
export function MobileWebBundleProbeRow() {
  const [hosts, setHosts] = useState<readonly HostProfile[]>([])
  useEffect(() => {
    let stale = false
    void loadHosts().then((loaded) => {
      if (!stale) {
        setHosts(loaded)
      }
    })
    return () => {
      stale = true
    }
  }, [])
  const hostId = selectDiagnosticsHostId(hosts, undefined, null)
  const { client } = useHostClient(hostId ?? undefined)
  const { state, run } = useMobileWebBundleProbe(client)

  return (
    <View>
      <Pressable
        style={({ pressed }) => [
          styles.diagnosticButton,
          pressed && styles.diagnosticButtonPressed,
          state.status === 'running' && styles.diagnosticButtonDisabled
        ]}
        testID="mobile-web-bundle-probe"
        onPress={run}
        disabled={state.status === 'running'}
      >
        {state.status === 'running' ? (
          <ActivityIndicator size="small" color={colors.textPrimary} />
        ) : (
          <Package size={16} color={colors.textPrimary} />
        )}
        <Text style={styles.diagnosticButtonLabel}>
          {state.status === 'running' ? 'Fetching bundle…' : 'Fetch mobile web bundle'}
        </Text>
      </Pressable>
      <ProbeResult state={state} />
    </View>
  )
}
