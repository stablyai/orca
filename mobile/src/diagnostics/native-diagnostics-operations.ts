import { Platform } from 'react-native'
import Constants from 'expo-constants'
import type { HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import {
  readConnectionDiagnosticsSnapshot,
  readHydratedConnectionLog
} from './connection-diagnostics-screen-data'
import { getReportableConnectionIncidentId } from './connection-diagnostics-analysis'
import {
  buildConnectionDiagnosticsReport,
  formatConnectionLogHistory
} from './connection-diagnostics-report'
import { NATIVE_APP_LOG_ID } from './native-render-log'
import { submitConnectionDiagnostics } from './connection-diagnostics-submission'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-frame-fields'

export function createNativeDiagnosticsOperations(
  host: HostProfile | null,
  context: Pick<
    RpcClientContextValue,
    'getState' | 'getReconnectAttempt' | 'getLastConnectedAt' | 'getActivePath' | 'getPendingPath'
  >,
  liveDesktopAppVersion?: string | null
): DiagnosticsDeviceOperations {
  const versionConnectedAt =
    host && context.getState(host.id) === 'connected' ? context.getLastConnectedAt(host.id) : null
  return {
    async report() {
      const appVersion = Constants.expoConfig?.version ?? 'unknown'
      const platform = `${Platform.OS} ${Platform.Version ?? ''}`.trim()
      const appEntries = await readHydratedConnectionLog(connectionLogStore, NATIVE_APP_LOG_ID)
      if (!host) {
        return {
          report: `Orca Mobile connection diagnostics\nApp: Orca Mobile ${appVersion} · ${platform}\nNo paired hosts.\n\n${formatConnectionLogHistory(appEntries)}`,
          appVersion,
          platform,
          incidentId: null
        }
      }
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
          desktopAppVersion:
            versionConnectedAt !== null && snapshot.lastConnectedAt === versionConnectedAt
              ? liveDesktopAppVersion
              : null,
          entries: [...snapshot.entries, ...appEntries].sort((a, b) => a.ts - b.ts),
          activePath: snapshot.activePath,
          pendingPath: snapshot.pendingPath,
          bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION
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
