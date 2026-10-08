import { Platform } from 'react-native'
import Constants from 'expo-constants'
import type { HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import { loadHostAppVersion } from '../transport/host-app-version-store'
import { readConnectionDiagnosticsSnapshot } from './connection-diagnostics-screen-data'
import { getReportableConnectionIncidentId } from './connection-diagnostics-analysis'
import { buildConnectionDiagnosticsReport } from './connection-diagnostics-report'
import { submitConnectionDiagnostics } from './connection-diagnostics-submission'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'

export function createNativeDiagnosticsOperations(
  host: HostProfile,
  context: RpcClientContextValue,
  liveDesktopAppVersion?: string | null
): DiagnosticsDeviceOperations {
  return {
    async report() {
      const appVersion = Constants.expoConfig?.version ?? 'unknown'
      const platform = `${Platform.OS} ${Platform.Version ?? ''}`.trim()
      const desktopAppVersion = liveDesktopAppVersion ?? (await loadHostAppVersion(host.id))
      const snapshot = await readConnectionDiagnosticsSnapshot(context, connectionLogStore, host.id)
      return {
        report: buildConnectionDiagnosticsReport({
          hostName: host.name,
          endpoint: host.endpoint,
          state: snapshot.state,
          reconnectAttempts: snapshot.reconnectAttempts,
          lastConnectedAt: snapshot.lastConnectedAt,
          platform,
          appVersion,
          desktopAppVersion,
          entries: snapshot.entries,
          activePath: snapshot.activePath,
          pendingPath: snapshot.pendingPath
        }),
        appVersion,
        platform,
        incidentId: getReportableConnectionIncidentId({
          endpoint: host.endpoint,
          state: snapshot.state,
          activePath: snapshot.activePath,
          pendingPath: snapshot.pendingPath,
          entries: snapshot.entries
        })
      }
    },
    submit: submitConnectionDiagnostics
  }
}
