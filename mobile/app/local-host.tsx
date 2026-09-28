import { useEffect, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { OrcaLocalRuntime, type LocalRuntimeStatus } from '../modules/orca-local-runtime/src'
import {
  canRunLocalHost,
  defaultDevOrcadBundleUrl
} from '../src/local-runtime/local-runtime-availability'
import { extractPairingCodeFromUrl } from '../src/transport/pairing'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'

const LOG_TAIL_LINES = 40

const PHASE_LABEL: Record<LocalRuntimeStatus['phase'], string> = {
  not_installed: 'Not installed',
  installing: 'Installing',
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  error: 'Error'
}

export default function LocalHostScreen() {
  const router = useRouter()
  // Reached by deep link or notification there is no stack to pop.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'))
  const runtime = canRunLocalHost() ? OrcaLocalRuntime : null
  const [status, setStatus] = useState<LocalRuntimeStatus | null>(
    () => runtime?.getStatus() ?? null
  )
  const [log, setLog] = useState<string[]>(
    () => runtime?.getRecentLog().slice(-LOG_TAIL_LINES) ?? []
  )
  const [bundleUrl, setBundleUrl] = useState(defaultDevOrcadBundleUrl)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!runtime) {
      return
    }
    const statusSub = runtime.addListener('onStatus', setStatus)
    const logSub = runtime.addListener('onLog', ({ line }) =>
      setLog((previous) => [...previous.slice(-(LOG_TAIL_LINES - 1)), line])
    )
    return () => {
      statusSub.remove()
      logSub.remove()
    }
  }, [runtime])

  if (!runtime || !status) {
    return (
      <SafeAreaView style={styles.container}>
        <Header onBack={goBack} />
        <Text style={styles.body}>
          Running Orca on this device needs the standalone Android build on an arm64 phone.
        </Text>
      </SafeAreaView>
    )
  }

  const run = (action: () => unknown) => {
    setActionError(null)
    Promise.resolve()
      .then(action)
      .catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : String(error))
      )
  }
  const pairingCode = status.pairingUrl ? extractPairingCodeFromUrl(status.pairingUrl) : null
  const busy = status.phase === 'installing' || status.phase === 'starting'
  const installed = status.phase !== 'not_installed' && status.phase !== 'installing'
  const live = status.phase === 'running' || status.phase === 'starting'

  return (
    <SafeAreaView style={styles.container}>
      <Header onBack={goBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.body}>
          Runs a full Orca host inside an Ubuntu userland on this phone, so terminals, git and
          coding agents work with no desktop. Only run projects and tools you trust: proot isolates
          nothing from the rest of this app's data.
        </Text>

        <View style={styles.card}>
          <Row label="Status" value={PHASE_LABEL[status.phase]} />
          {status.installStep ? <Row label="Step" value={status.installStep} /> : null}
          {status.endpoint ? <Row label="Endpoint" value={status.endpoint} /> : null}
          {status.restartCount > 0 ? (
            <Row label="Restarts" value={String(status.restartCount)} />
          ) : null}
          {status.lastError ? <Text style={styles.error}>{status.lastError}</Text> : null}
          {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
        </View>

        {!live ? (
          <View style={styles.card}>
            <Text style={styles.label}>orcad bundle (.tar.gz)</Text>
            <TextInput
              style={styles.input}
              value={bundleUrl}
              onChangeText={setBundleUrl}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button
              label={installed ? 'Reinstall orcad' : 'Install'}
              disabled={busy}
              onPress={() => run(() => runtime.install({ orcadBundleUrl: bundleUrl.trim() }))}
            />
          </View>
        ) : null}

        <View style={styles.actions}>
          {installed && !live ? (
            <Button label="Start host" onPress={() => run(() => runtime.start())} />
          ) : null}
          {live ? <Button label="Stop host" onPress={() => run(() => runtime.stop())} /> : null}
          {status.phase === 'running' && status.webClientUrl ? (
            <Button label="Open desktop UI" primary onPress={() => router.push('/desktop')} />
          ) : null}
          {status.phase === 'running' && pairingCode ? (
            <Button
              label="Connect to this device"
              primary={!status.webClientUrl}
              onPress={() =>
                router.push({ pathname: '/pair-confirm', params: { code: pairingCode } })
              }
            />
          ) : null}
          {!runtime.isIgnoringBatteryOptimizations() ? (
            <Button
              label="Keep running in background"
              onPress={() => run(() => runtime.requestIgnoreBatteryOptimizations())}
            />
          ) : null}
        </View>

        {log.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.label}>Log</Text>
            <Text style={styles.log} selectable>
              {log.join('\n')}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function Header(props: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={props.onBack} hitSlop={12} accessibilityLabel="Back">
        <ChevronLeft size={22} color={colors.textPrimary} />
      </Pressable>
      <Text style={styles.title}>This device</Text>
    </View>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{props.label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  )
}

function Button(props: {
  label: string
  onPress: () => void
  primary?: boolean
  disabled?: boolean
}) {
  return (
    <Pressable
      style={[
        styles.button,
        props.primary && styles.buttonPrimary,
        props.disabled && styles.buttonDisabled
      ]}
      onPress={props.onPress}
      disabled={props.disabled}
    >
      <Text style={[styles.buttonText, props.primary && styles.buttonTextPrimary]}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md
  },
  title: { fontSize: typography.titleSize, fontWeight: '600', color: colors.textPrimary },
  content: { padding: spacing.lg, gap: spacing.lg },
  body: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.lg
  },
  card: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    padding: spacing.lg,
    gap: spacing.sm
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  rowLabel: { fontSize: typography.bodySize, color: colors.textMuted },
  rowValue: { fontSize: typography.bodySize, color: colors.textPrimary, flexShrink: 1 },
  label: { fontSize: typography.metaSize, color: colors.textMuted },
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    color: colors.textPrimary,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm
  },
  error: { fontSize: typography.metaSize, color: colors.statusRed },
  actions: { gap: spacing.sm },
  button: {
    borderRadius: radii.button,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised,
    paddingVertical: spacing.md,
    alignItems: 'center'
  },
  buttonPrimary: { backgroundColor: colors.surfaceBright, borderColor: colors.surfaceBright },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: typography.bodySize, fontWeight: '600', color: colors.textPrimary },
  buttonTextPrimary: { color: colors.bgBase },
  log: { fontFamily: typography.monoFamily, fontSize: 11, color: colors.textSecondary }
})
