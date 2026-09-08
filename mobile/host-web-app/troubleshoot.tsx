import { useRef, useState } from 'react'
import type { View } from 'react-native'
import { useRouter } from 'expo-router'
import { useMobileWebNativeShell } from '../../src/mobile-web/src/native-shell-channel'
import {
  TroubleshootView,
  type CheckResult,
  type DiagnosticStatus
} from '../src/diagnostics/troubleshoot-view'

export default function HostedTroubleshootRoute() {
  const router = useRouter()
  const shell = useMobileWebNativeShell()
  const [status, setStatus] = useState<DiagnosticStatus>('idle')
  const [checks, setChecks] = useState<CheckResult[]>([])
  const active = useRef(true)
  const device = shell.client?.native.diagnosticsDevice
  const runDiagnostics = async () => {
    if (!device || status === 'running') {
      return
    }
    active.current = true
    setStatus('running')
    setChecks([])
    const results: CheckResult[] = []
    try {
      const snapshot = await device.snapshot()
      results.push({ label: 'Paired desktop', status: 'pass', detail: 'Paired' })
      for (const target of ['internet', 'host'] as const) {
        const { reachable } = await device.probe(target)
        if (!active.current) {
          return
        }
        results.push({
          label: target === 'internet' ? 'Internet' : 'Paired desktop',
          status: reachable ? 'pass' : 'fail',
          detail: reachable
            ? 'Reachable'
            : target === 'host' && snapshot.endpointIsTailscale
              ? 'Check the Tailscale connection and confirm the desktop is awake.'
              : 'Could not reach from this device.'
        })
        setChecks([...results])
      }
      results.push({ label: 'Platform', status: 'pass', detail: snapshot.platform })
    } catch {
      results.push({
        label: 'Diagnostics',
        status: 'warn',
        detail: 'Could not complete checks. Try again.'
      })
    }
    if (active.current) {
      setChecks(results)
      setStatus('done')
    }
  }
  return (
    <TroubleshootView
      rootRef={(node: View | null) => {
        active.current = node !== null
      }}
      diagnosticStatus={status}
      checks={checks}
      runDiagnostics={() => void runDiagnostics()}
      onBack={() => (router.canGoBack() ? router.back() : router.replace('/settings'))}
      onConnectionLog={() => router.push('/connection-log')}
    />
  )
}
