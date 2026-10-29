import { useCallback, useRef, useState } from 'react'
import type { View } from 'react-native'
import { Platform } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { loadHosts } from '../transport/host-store'
import {
  startDiagnosticFetchTimeout,
  type DiagnosticFetchTimeout
} from './diagnostic-fetch-timeout'
import { formatEndpoint, testHostReachability, unreachableHostDetail } from './host-reachability'
import type { CheckResult, DiagnosticStatus } from './troubleshoot-view'

export function useTroubleshootDiagnostics() {
  const t = useMobileTranslation()
  const [diagnosticStatus, setDiagnosticStatus] = useState<DiagnosticStatus>('idle')
  const [checks, setChecks] = useState<CheckResult[]>([])
  const abortRef = useRef(false)
  const diagnosticRunRef = useRef(0)
  const activeInternetCheckRef = useRef<DiagnosticFetchTimeout | null>(null)

  const rootRef = useCallback((node: View | null): void => {
    if (node !== null) {
      return
    }
    // Cancel diagnostics when the route detaches; a run can outlive the screen.
    abortRef.current = true
    diagnosticRunRef.current += 1
    activeInternetCheckRef.current?.dispose()
    activeInternetCheckRef.current = null
  }, [])

  const runDiagnostics = useCallback(async () => {
    const runId = diagnosticRunRef.current + 1
    diagnosticRunRef.current = runId
    abortRef.current = false
    activeInternetCheckRef.current?.dispose()
    activeInternetCheckRef.current = null
    setDiagnosticStatus('running')
    setChecks([])

    const results: CheckResult[] = []
    const isCurrentRun = () => !abortRef.current && diagnosticRunRef.current === runId

    try {
      const hosts = await loadHosts()
      results.push(
        hosts.length > 0
          ? {
              label: t('diagnostics.useTroubleshootDiagnostics.pairedHosts', 'Paired hosts'),
              status: 'pass',
              detail: t('diagnostics.useTroubleshootDiagnostics.pairedCount', '{{count}} paired', {
                count: hosts.length
              })
            }
          : {
              label: t('diagnostics.useTroubleshootDiagnostics.pairedHosts', 'Paired hosts'),
              status: 'fail',
              detail: t(
                'diagnostics.useTroubleshootDiagnostics.noPairedHosts',
                'None — scan a QR to pair'
              )
            }
      )
    } catch {
      results.push({
        label: t('diagnostics.useTroubleshootDiagnostics.pairedHosts', 'Paired hosts'),
        status: 'warn',
        detail: t(
          'diagnostics.useTroubleshootDiagnostics.hostDataFailed',
          'Could not read host data'
        )
      })
    }

    if (!isCurrentRun()) {
      return
    }
    setChecks([...results])

    const internetCheck = startDiagnosticFetchTimeout(5000)
    activeInternetCheckRef.current = internetCheck
    try {
      const resp = await fetch('https://dns.google/resolve?name=example.com&type=A', {
        signal: internetCheck.signal
      })
      if (!isCurrentRun()) {
        return
      }
      results.push(
        resp.ok
          ? {
              label: t('diagnostics.useTroubleshootDiagnostics.internet', 'Internet'),
              status: 'pass',
              detail: t('diagnostics.useTroubleshootDiagnostics.connected', 'Connected')
            }
          : {
              label: t('diagnostics.useTroubleshootDiagnostics.internet', 'Internet'),
              status: 'warn',
              detail: t(
                'diagnostics.useTroubleshootDiagnostics.unexpectedResponse',
                'Unexpected response'
              )
            }
      )
    } catch {
      if (!isCurrentRun()) {
        return
      }
      results.push({
        label: t('diagnostics.useTroubleshootDiagnostics.internet', 'Internet'),
        status: 'fail',
        detail: t('diagnostics.useTroubleshootDiagnostics.noConnection', 'No connection')
      })
    } finally {
      internetCheck.dispose()
      if (activeInternetCheckRef.current === internetCheck) {
        activeInternetCheckRef.current = null
      }
    }

    if (!isCurrentRun()) {
      return
    }
    setChecks([...results])

    try {
      const hosts = await loadHosts()
      for (const host of hosts) {
        if (!isCurrentRun()) {
          return
        }
        const reachable = await testHostReachability(host.endpoint)
        if (!isCurrentRun()) {
          return
        }
        results.push({
          label: host.name,
          status: reachable ? 'pass' : 'fail',
          detail: reachable
            ? t('diagnostics.useTroubleshootDiagnostics.reachable', 'Reachable at {{endpoint}}', {
                endpoint: formatEndpoint(host.endpoint)
              })
            : unreachableHostDetail(host.endpoint)
        })
        setChecks([...results])
      }
    } catch {
      results.push({
        label: t('diagnostics.useTroubleshootDiagnostics.hosts', 'Hosts'),
        status: 'warn',
        detail: t('diagnostics.useTroubleshootDiagnostics.hostTestFailed', 'Could not test')
      })
    }

    if (!isCurrentRun()) {
      return
    }

    results.push({
      label: t('diagnostics.useTroubleshootDiagnostics.platform', 'Platform'),
      status: 'pass',
      detail: `${Platform.OS} ${Platform.Version ?? ''}`
    })

    setChecks([...results])
    setDiagnosticStatus('done')
  }, [t])

  return { rootRef, diagnosticStatus, checks, runDiagnostics }
}
