import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Package } from 'lucide-react-native'
import { loadHosts } from '../transport/host-store'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { troubleshootScreenStyles as styles } from './troubleshoot-screen-styles'
import {
  useMobileWebBundleProbe,
  type MobileWebBundleProbeState
} from './use-mobile-web-bundle-probe'
import type { HostProfile } from '../transport/types'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { ListGroup, ListRow } from '../components/list/ListGroup'

function buttonLabel(
  state: MobileWebBundleProbeState,
  awaitingHost: boolean,
  t: Translate
): string {
  if (state.status !== 'running') {
    return t('diagnostics.mobileWebBundleProbeRow.fetchBundle', 'Fetch mobile web bundle')
  }
  return awaitingHost
    ? t('diagnostics.mobileWebBundleProbeRow.connecting', 'Connecting…')
    : t('diagnostics.mobileWebBundleProbeRow.fetching', 'Fetching bundle…')
}

function ProbeLine({ label, detail, failed }: { label: string; detail: string; failed?: boolean }) {
  useMobileColorScheme()
  return failed === true ? (
    <ListRow
      title={label}
      detail={<Text style={[styles.checkDetail, styles.checkDetailFail]}>{detail}</Text>}
    />
  ) : (
    <ListRow title={label} value={detail} />
  )
}

function ProbeResult({ state, hostName }: { state: MobileWebBundleProbeState; hostName: string }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  if (state.status === 'idle' || state.status === 'running') {
    return null
  }
  if (state.status === 'failed') {
    return (
      <ListGroup style={styles.group}>
        <ProbeLine
          key="bundle"
          label={t('diagnostics.mobileWebBundleProbeRow.bundle', 'Bundle')}
          detail={state.detail}
          failed
        />
      </ListGroup>
    )
  }
  return (
    <ListGroup style={styles.group}>
      <ProbeLine
        key="host"
        label={t('diagnostics.mobileWebBundleProbeRow.host', 'Host')}
        detail={hostName}
      />
      <ProbeLine
        key="build"
        label={t('diagnostics.mobileWebBundleProbeRow.build', 'Build')}
        detail={state.buildId.slice(0, 12)}
      />
      <ProbeLine
        key="assets"
        label={t('diagnostics.mobileWebBundleProbeRow.assets', 'Assets')}
        detail={`${state.assetCount}`}
      />
      <ProbeLine
        key="bytes"
        label={t('diagnostics.mobileWebBundleProbeRow.bytes', 'Bytes')}
        detail={`${state.totalBytes}`}
      />
      <ProbeLine
        key="elapsed"
        label={t('diagnostics.mobileWebBundleProbeRow.elapsed', 'Elapsed')}
        detail={t('diagnostics.mobileWebBundleProbeRow.elapsedMilliseconds', '{{elapsedMs}} ms', {
          elapsedMs: state.elapsedMs
        })}
      />
    </ListGroup>
  )
}

// Dev-only end-to-end bundle fetch; troubleshoot.tsx gates this behind __DEV__. It neither caches nor renders the bundle.
// Troubleshoot has no selected host, so probe the first paired host and name it explicitly.
export function MobileWebBundleProbeRow() {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
        <Text style={styles.diagnosticButtonLabel}>{buttonLabel(state, awaitingHost, t)}</Text>
      </Pressable>
      <ProbeResult
        state={state}
        hostName={
          host?.name ?? t('diagnostics.mobileWebBundleProbeRow.unknownHost', 'unknown host')
        }
      />
    </View>
  )
}
