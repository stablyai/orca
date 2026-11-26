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

const relayCredentialReads = new Map<string, Promise<MobileRelayCredentialBundle | null>>()

// The read queues behind every keychain mutation, so taps share one read and one 2 s deadline per
// host; once it lapses, later taps settle at once instead of each waiting again. A fresh read starts only after the native one settles.
function readRelayCredentialForReport(hostId: string): Promise<MobileRelayCredentialBundle | null> {
  const shared = relayCredentialReads.get(hostId)
  if (shared) {
    return shared
  }
  const read = readMobileRelayCredentialBundle(hostId)
  const result = withTimeout(read, 2_000, null)
  relayCredentialReads.set(hostId, result)
  void read.catch(() => null).finally(() => relayCredentialReads.delete(hostId))
  return result
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
