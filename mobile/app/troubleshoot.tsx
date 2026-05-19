import { useState, useCallback, useEffect, useRef } from 'react'
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Platform
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import {
  ChevronLeft,
  ChevronDown,
  ChevronUp,
  WifiOff,
  Shield,
  Monitor,
  Clock,
  Globe,
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle
} from 'lucide-react-native'
import { colors, spacing, typography } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'

type DiagnosticStatus = 'idle' | 'running' | 'done'

type CheckResult = {
  label: string
  status: 'pass' | 'fail' | 'warn'
  detail: string
}

type TroubleshootSection = {
  id: string
  icon: React.ReactNode
  title: string
  steps: string[]
}

const sections: TroubleshootSection[] = [
  {
    id: 'wifi',
    icon: <WifiOff size={16} color={colors.textSecondary} />,
    title: 'Different WiFi Networks',
    steps: [
      'Both devices must be on the same local network.',
      'Ethernet and WiFi must share the same subnet.',
      'Try reconnecting WiFi on both devices.'
    ]
  },
  {
    id: 'firewall',
    icon: <Shield size={16} color={colors.textSecondary} />,
    title: 'Firewall Blocking Port 6768',
    steps: [
      'macOS: System Settings → Network → Firewall — allow Orca.',
      'Windows: Defender Firewall → Allow app — enable Orca for Private networks.',
      'Linux: sudo ufw allow 6768',
      'Corporate/school networks may block P2P — try a personal hotspot.'
    ]
  },
  {
    id: 'desktop',
    icon: <Monitor size={16} color={colors.textSecondary} />,
    title: 'Desktop App Not Running',
    steps: [
      'Orca must be open on your desktop to accept connections.',
      'Try restarting Orca — the companion server starts on launch.',
      'After an update, you may need to re-pair via QR code.'
    ]
  },
  {
    id: 'timeout',
    icon: <Clock size={16} color={colors.textSecondary} />,
    title: 'Connection Timeout',
    steps: [
      'Check WiFi signal strength on your phone.',
      'Go back to the host list and tap your host to retry.',
      'Restart both apps if timeouts persist.'
    ]
  },
  {
    id: 'vpn',
    icon: <Globe size={16} color={colors.textSecondary} />,
    title: 'VPN Interference',
    steps: [
      'VPNs can route local traffic through a remote server.',
      'Disable the VPN or enable split tunneling / "Allow LAN".'
    ]
  }
]

function StatusIcon({ status }: { status: CheckResult['status'] }) {
  switch (status) {
    case 'pass':
      return <CheckCircle2 size={14} color={colors.statusGreen} />
    case 'fail':
      return <XCircle size={14} color={colors.statusRed} />
    case 'warn':
      return <AlertTriangle size={14} color={colors.textMuted} />
  }
}

export default function TroubleshootScreen() {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [diagnosticStatus, setDiagnosticStatus] = useState<DiagnosticStatus>('idle')
  const [checks, setChecks] = useState<CheckResult[]>([])
  const abortRef = useRef(false)

  useEffect(() => {
    return () => {
      abortRef.current = true
    }
  }, [])

  const toggleSection = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const runDiagnostics = useCallback(async () => {
    abortRef.current = false
    setDiagnosticStatus('running')
    setChecks([])

    const results: CheckResult[] = []

    try {
      const hosts = await loadHosts()
      results.push(
        hosts.length > 0
          ? { label: 'Paired hosts', status: 'pass', detail: `${hosts.length} paired` }
          : { label: 'Paired hosts', status: 'fail', detail: 'None — scan a QR to pair' }
      )
    } catch {
      results.push({ label: 'Paired hosts', status: 'warn', detail: 'Could not read host data' })
    }

    if (abortRef.current) return
    setChecks([...results])

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 5000)
      const resp = await fetch('https://dns.google/resolve?name=example.com&type=A', {
        signal: controller.signal
      })
      clearTimeout(timeout)
      results.push(
        resp.ok
          ? { label: 'Internet', status: 'pass', detail: 'Connected' }
          : { label: 'Internet', status: 'warn', detail: 'Unexpected response' }
      )
    } catch {
      results.push({ label: 'Internet', status: 'fail', detail: 'No connection' })
    }

    if (abortRef.current) return
    setChecks([...results])

    try {
      const hosts = await loadHosts()
      for (const host of hosts) {
        if (abortRef.current) return
        const reachable = await testHostReachability(host.endpoint)
        results.push({
          label: host.name,
          status: reachable ? 'pass' : 'fail',
          detail: reachable
            ? `Reachable at ${formatEndpoint(host.endpoint)}`
            : `Cannot reach ${formatEndpoint(host.endpoint)}`
        })
        setChecks([...results])
      }
    } catch {
      results.push({ label: 'Hosts', status: 'warn', detail: 'Could not test' })
    }

    if (abortRef.current) return

    results.push({
      label: 'Platform',
      status: 'pass',
      detail: `${Platform.OS} ${Platform.Version ?? ''}`
    })

    setChecks([...results])
    setDiagnosticStatus('done')
  }, [])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Troubleshooting</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Pressable
          style={({ pressed }) => [
            styles.diagnosticButton,
            pressed && styles.diagnosticButtonPressed,
            diagnosticStatus === 'running' && styles.diagnosticButtonDisabled
          ]}
          onPress={runDiagnostics}
          disabled={diagnosticStatus === 'running'}
        >
          {diagnosticStatus === 'running' ? (
            <ActivityIndicator size="small" color={colors.textPrimary} />
          ) : (
            <Activity size={16} color={colors.textPrimary} />
          )}
          <Text style={styles.diagnosticButtonLabel}>
            {diagnosticStatus === 'running'
              ? 'Running…'
              : diagnosticStatus === 'done'
                ? 'Run again'
                : 'Run diagnostics'}
          </Text>
        </Pressable>

        {checks.length > 0 && (
          <View style={styles.section}>
            {checks.map((check, i) => (
              <View key={i}>
                {i > 0 && <View style={styles.separator} />}
                <View style={styles.checkRow}>
                  <StatusIcon status={check.status} />
                  <Text style={styles.checkLabel}>{check.label}</Text>
                  <Text
                    style={[styles.checkDetail, check.status === 'fail' && styles.checkDetailFail]}
                  >
                    {check.detail}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        )}

        <Text style={styles.sectionHeading}>Common issues</Text>

        <View style={styles.section}>
          {sections.map((section, i) => (
            <View key={section.id}>
              {i > 0 && <View style={styles.separator} />}
              <Pressable
                style={({ pressed }) => [styles.accordionHeader, pressed && styles.rowPressed]}
                onPress={() => toggleSection(section.id)}
              >
                {section.icon}
                <Text style={styles.accordionTitle}>{section.title}</Text>
                {expandedId === section.id ? (
                  <ChevronUp size={16} color={colors.textMuted} />
                ) : (
                  <ChevronDown size={16} color={colors.textMuted} />
                )}
              </Pressable>
              {expandedId === section.id && (
                <View style={styles.accordionBody}>
                  {section.steps.map((step, j) => (
                    <View key={j} style={styles.stepRow}>
                      <Text style={styles.bullet}>•</Text>
                      <Text style={styles.stepText}>{step}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ))}
        </View>

        <View style={{ height: spacing.xl }} />
      </ScrollView>
    </View>
  )
}

// Why: WebSocket reachability is tested by opening a connection and waiting for
// the server to respond with any frame, or timing out after 4 seconds.
// We don't complete the E2EE handshake — just verify the endpoint is listening.
async function testHostReachability(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close()
      resolve(false)
    }, 4000)

    const ws = new WebSocket(endpoint)

    ws.onopen = () => {
      clearTimeout(timeout)
      ws.close()
      resolve(true)
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      resolve(false)
    }
  })
}

function formatEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.host
  } catch {
    return endpoint
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    padding: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  scroll: {
    flex: 1
  },
  scrollContent: {
    paddingBottom: spacing.xl
  },
  diagnosticButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.bgRaised,
    borderRadius: 10,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.lg
  },
  diagnosticButtonPressed: {
    opacity: 0.7
  },
  diagnosticButtonDisabled: {
    opacity: 0.5
  },
  diagnosticButtonLabel: {
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.md + 2
  },
  checkLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  checkDetail: {
    flex: 1,
    textAlign: 'right',
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  checkDetailFail: {
    color: colors.statusRed
  },
  sectionHeading: {
    fontSize: typography.metaSize,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.sm,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: spacing.lg
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  },
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  accordionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  accordionTitle: {
    flex: 1,
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  accordionBody: {
    paddingHorizontal: spacing.md + 2,
    paddingBottom: spacing.md,
    gap: spacing.xs + 2
  },
  stepRow: {
    flexDirection: 'row',
    gap: spacing.sm
  },
  bullet: {
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  },
  stepText: {
    flex: 1,
    fontSize: typography.metaSize,
    color: colors.textMuted,
    lineHeight: 18
  }
})
