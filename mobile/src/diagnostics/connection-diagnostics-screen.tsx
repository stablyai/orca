import { useCallback, useState, type ReactNode } from 'react'
import { ConnectionDiagnosticsView } from './connection-diagnostics-view'
import {
  diagnoseConnection,
  getReportableConnectionIncidentId
} from './connection-diagnostics-analysis'
import {
  getDiagnosticsSubmissionState,
  updateDiagnosticsSubmissionState,
  type DiagnosticsSubmissionStates
} from './connection-diagnostics-screen-data'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'
import type {
  ConnectionLogEntry,
  ConnectionState,
  MobileConnectionDiagnosticPath
} from '../transport/types'

export function ConnectionDiagnosticsScreen({
  device,
  hostId,
  hostName,
  endpoint,
  state,
  reconnectAttempts,
  activePath,
  pendingPath,
  entries,
  writeClipboard,
  onBack,
  hostPicker
}: {
  device: DiagnosticsDeviceOperations | null
  hostId: string | null
  hostName: string | null
  endpoint: string | null
  state: ConnectionState
  reconnectAttempts: number
  activePath?: MobileConnectionDiagnosticPath
  pendingPath?: MobileConnectionDiagnosticPath | null
  entries: readonly ConnectionLogEntry[]
  writeClipboard: (report: string) => Promise<unknown>
  onBack: () => void
  hostPicker?: ReactNode
}) {
  const [copiedHostId, setCopiedHostId] = useState<string | null>(null)
  const [submissionStates, setSubmissionStates] = useState<DiagnosticsSubmissionStates>({})

  const diagnosisArgs = endpoint ? { endpoint, state, activePath, pendingPath, entries } : null
  const diagnosis = diagnosisArgs ? diagnoseConnection(diagnosisArgs) : null
  const incidentId = diagnosisArgs ? getReportableConnectionIncidentId(diagnosisArgs) : null
  const submissionKey = hostId && incidentId ? `${hostId}:${incidentId}` : null
  const submissionState = getDiagnosticsSubmissionState(submissionStates, submissionKey)
  const copied = copiedHostId !== null && copiedHostId === hostId

  const copyDiagnostics = useCallback(async () => {
    if (!device || !hostId) {
      return
    }
    const { report } = await device.report()
    await writeClipboard(report)
    setCopiedHostId(hostId)
    setTimeout(() => setCopiedHostId((current) => (current === hostId ? null : current)), 2000)
  }, [device, hostId, writeClipboard])

  const sendDiagnostics = useCallback(async () => {
    if (!device || !hostId || !submissionKey || submissionState === 'sending') {
      return
    }
    const startedKey = submissionKey
    setSubmissionStates((states) => updateDiagnosticsSubmissionState(states, startedKey, 'sending'))
    const fresh = await device.report()
    if (`${hostId}:${fresh.incidentId ?? ''}` !== startedKey) {
      setSubmissionStates((states) => updateDiagnosticsSubmissionState(states, startedKey, null))
      return
    }
    const result = await device.submit({
      report: fresh.report,
      appVersion: fresh.appVersion,
      platform: fresh.platform
    })
    setSubmissionStates((states) =>
      updateDiagnosticsSubmissionState(states, startedKey, result.ok ? 'sent' : 'failed')
    )
  }, [device, hostId, submissionKey, submissionState])

  return (
    <ConnectionDiagnosticsView
      hostName={hostName}
      state={state}
      reconnectAttempts={reconnectAttempts}
      entries={entries}
      diagnosis={diagnosis}
      copied={copied}
      copyDiagnostics={copyDiagnostics}
      submissionState={submissionState}
      sendDiagnostics={sendDiagnostics}
      onBack={onBack}
      hostPicker={hostPicker}
    />
  )
}
