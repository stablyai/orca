import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { Package } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { colors } from '../theme/mobile-theme'
import { Button } from '../components/ui/Button'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import {
  useMobileWebBundleProbe,
  type MobileWebBundleProbeState
} from './use-mobile-web-bundle-probe'
import type { HostProfile } from '../transport/types'

/** Dialling the desktop is part of the tap, so the label says which half is still running. */
function buttonLabel(state: MobileWebBundleProbeState, awaitingHost: boolean): string {
  if (state.status !== 'running') {
    return 'Fetch mobile web bundle'
  }
  return awaitingHost ? 'Connecting…' : 'Fetching bundle…'
}

function ProbeResult({ state, hostName }: { state: MobileWebBundleProbeState; hostName: string }) {
  if (state.status === 'idle' || state.status === 'running') {
    return null
  }
  if (state.status === 'failed') {
    return (
      <ListGroup style={styles.results}>
        <ListRow
          title="Bundle"
          subtitle={state.detail}
          subtitleColor={colors.danger}
          subtitleNumberOfLines={4}
        />
      </ListGroup>
    )
  }
  return (
    <ListGroup style={styles.results}>
      <ListRow title="Desktop" value={hostName} />
      <ListRow title="Build" value={state.buildId.slice(0, 12)} />
      <ListRow title="Assets" value={`${state.assetCount}`} />
      <ListRow title="Bytes" value={`${state.totalBytes}`} />
      <ListRow title="Elapsed" value={`${state.elapsedMs} ms`} />
    </ListGroup>
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
      <View style={styles.actions}>
        <Button
          label={buttonLabel(state, awaitingHost)}
          onPress={run}
          icon={Package}
          busy={state.status === 'running'}
          block
          testID="mobile-web-bundle-probe"
        />
      </View>
      <ProbeResult state={state} hostName={host?.name ?? 'Unknown desktop'} />
    </View>
  )
}
