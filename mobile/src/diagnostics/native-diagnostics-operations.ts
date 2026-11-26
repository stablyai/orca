import { Platform } from 'react-native'
import Constants from 'expo-constants'
import type { HostProfile } from '../host-catalog/host-profile'
import type { RpcClientContextValue } from '../transport/connection/rpc-client-context-contract'
import { connectionLogStore } from './connection/persisted-connection-log-store'
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
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/protocol/bridge-frame-fields'
import {
  readMobileRelayCredentialBundle,
  type MobileRelayCredentialBundle
} from '../host-credentials/mobile-relay-credential-bundle'
import { withTimeout } from '../../../src/shared/concurrency/promise-timeout-fallback'

// The read queues behind every keychain mutation: a report never waits on an unrelated write, and
// repeated taps share one read instead of stacking reads that run after their reports finished.
const relayCredentialReads = new Map<string, Promise<MobileRelayCredentialBundle | null>>()

function readRelayCredentialForReport(hostId: string): Promise<MobileRelayCredentialBundle | null> {
  let read = relayCredentialReads.get(hostId)
  if (!read) {
    read = readMobileRelayCredentialBundle(hostId)
      .catch(() => null)
      .finally(() => relayCredentialReads.delete(hostId))
    relayCredentialReads.set(hostId, read)
  }
  return withTimeout(read, 2_000, null)
}

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
      const relayCredential = host.relay ? await readRelayCredentialForReport(host.id) : undefined
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
          bridgeProtocolVersion: BRIDGE_PROTOCOL_VERSION,
          relayCredential
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
