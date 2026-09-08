import { useCallback, useState, type ReactNode } from 'react'
import { Text } from 'react-native'
import { useFocusEffect } from 'expo-router'
import type { DiagnosticsSnapshot } from '../../../src/shared/mobile-web/diagnostics-device-contract'
import type { ConnectionLogEntry } from '../transport/types'
import type { MobileWebDiagnosticsSnapshot } from '../mobile-web/mobile-web-diagnostics-store'
import { ConnectionDiagnosticsView } from './connection-diagnostics-view'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import { buildConnectionDiagnosticsReport } from './connection-diagnostics-report'
import {
  getDiagnosticsSubmissionState,
  updateDiagnosticsSubmissionState,
  type DiagnosticsSubmissionStates
} from './connection-diagnostics-screen-data'
import { connectionDiagnosticsScreenStyles as styles } from './connection-diagnostics-screen-styles'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'

function reportable(snapshot: DiagnosticsSnapshot) {
  return {
    ...snapshot,
    entries: snapshot.entries as ConnectionLogEntry[],
    mobileWeb: snapshot.mobileWeb as MobileWebDiagnosticsSnapshot
  }
}

// Why: reading the log matters most while a host is failing, so the screen
// re-polls the device instead of rendering a snapshot taken on mount.
export function ConnectionDiagnosticsScreen({
  device,
  hostName,
  writeClipboard,
  onBack,
  hostPicker
}: {
  device: DiagnosticsDeviceOperations | null
  hostName: string | null
  writeClipboard: (report: string) => Promise<unknown>
  onBack: () => void
  hostPicker?: ReactNode
}) {
  const [snapshot, setSnapshot] = useState<DiagnosticsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [submissions, setSubmissions] = useState<DiagnosticsSubmissionStates>({})
  useFocusEffect(
    useCallback(() => {
      if (!device) {
        return
      }
      let active = true
      let pending = false
      const refresh = async () => {
        if (pending) {
          return
        }
        pending = true
        try {
          const next = await device.snapshot()
          if (active) {
            setSnapshot(next)
            setError(null)
          }
        } catch {
          if (active) {
            setError('Could not load network diagnostics. Retrying…')
          }
        } finally {
          pending = false
        }
      }
      void refresh()
      const interval = setInterval(() => void refresh(), 2000)
      return () => {
        active = false
        clearInterval(interval)
      }
    }, [device])
  )
  const data = snapshot ? reportable(snapshot) : null
  const diagnosis = data ? diagnoseConnection(data) : null
  const incident = data ? getReportableConnectionIncidentId(data) : null
  const submissionState = getDiagnosticsSubmissionState(submissions, incident)
  const copyDiagnostics = async () => {
    if (!device) {
      return
    }
    try {
      await writeClipboard(buildConnectionDiagnosticsReport(reportable(await device.snapshot())))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Could not copy the report. Try again.')
    }
  }
  const sendDiagnostics = async () => {
    if (!device || !incident || submissionState === 'sending') {
      return
    }
    const started = incident
    setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, 'sending'))
    try {
      const fresh = await device.snapshot()
      const reportData = reportable(fresh)
      if (getReportableConnectionIncidentId(reportData) !== started) {
        setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, null))
        return
      }
      const result = await device.submit({
        report: buildConnectionDiagnosticsReport(reportData),
        appVersion: fresh.appVersion,
        platform: fresh.platform
      })
      setSubmissions((states) =>
        updateDiagnosticsSubmissionState(states, started, result.ok ? 'sent' : 'failed')
      )
    } catch {
      setSubmissions((states) => updateDiagnosticsSubmissionState(states, started, 'failed'))
    }
  }
  return (
    <ConnectionDiagnosticsView
      loading={Boolean(device) && !snapshot}
      hostName={hostName}
      state={snapshot?.state ?? 'disconnected'}
      reconnectAttempts={snapshot?.reconnectAttempts ?? 0}
      entries={data?.entries ?? []}
      diagnosis={diagnosis}
      copied={copied}
      copyDiagnostics={copyDiagnostics}
      submissionState={submissionState}
      sendDiagnostics={sendDiagnostics}
      onBack={onBack}
      hostPicker={
        <>
          {hostPicker}
          {error ? (
            <Text accessibilityRole="alert" style={styles.emptyText}>
              {error}
            </Text>
          ) : null}
        </>
      }
    />
  )
}
