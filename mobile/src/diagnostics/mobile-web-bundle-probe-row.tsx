import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Package } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { colors } from '../theme/mobile-theme'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import {
  useMobileWebBundleProbe,
  type MobileWebBundleProbeState
} from './use-mobile-web-bundle-probe'
import type { HostProfile } from '../transport/types'

/** Dialling the host is part of the tap, so the label says which half is still running. */
function buttonLabel(state: MobileWebBundleProbeState, awaitingHost: boolean): string {
  if (state.status !== 'running') {
    return 'Fetch mobile web bundle'
  }
  return awaitingHost ? 'Connecting…' : 'Fetching bundle…'
}

/** One `label — detail` line in the same row shape the diagnostic checks use. */
function ProbeLine({ label, detail, failed }: { label: string; detail: string; failed?: boolean }) {
  return (
    <View style={styles.checkRow}>
      <Text style={styles.checkLabel}>{label}</Text>
      <Text style={[styles.checkDetail, failed === true && styles.checkDetailFail]}>{detail}</Text>
    </View>
  )
}

function ProbeResult({ state, hostName }: { state: MobileWebBundleProbeState; hostName: string }) {
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
      <ProbeLine label="Host" detail={hostName} />
      <View style={styles.separator} />
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
 * Development-only: fetches the whole mobile web bundle from a paired desktop and reports what came
 * back. Phase A ships no production path that renders a bundle, and this row is the only thing that
 * exercises the operations end to end on a device.
 *
 * `app/troubleshoot.tsx` mounts it behind `__DEV__`, so a shipped build never runs the host lookup.
 *
 * The screen carries no host parameter and troubleshoots every paired host, one reachability check
 * each, so there is no host it is "on". The probe takes the first paired host and names it in the
 * result rather than implying it speaks for all of them.
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
  const host = hosts[0] ?? null
  const { state, run, awaitingHost } = useMobileWebBundleProbe(host?.id ?? null)

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
        <Text style={styles.diagnosticButtonLabel}>{buttonLabel(state, awaitingHost)}</Text>
      </Pressable>
      <ProbeResult state={state} hostName={host?.name ?? 'unknown host'} />
    </View>
  )
}
