import { Platform } from 'react-native'
import Constants from 'expo-constants'
import { isTailscaleEndpoint } from '../../../src/shared/remote-runtime-tailscale-hint'
import type { HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { connectionLogStore } from '../transport/persisted-connection-log-store'
import { loadHostAppVersion } from '../transport/host-app-version-store'
import { mobileWebDiagnosticsStore } from '../mobile-web/mobile-web-diagnostics-store'
import { readConnectionDiagnosticsSnapshot } from './connection-diagnostics-screen-data'
import { redactConnectionLogEntry } from './connection-log-redaction'
import { testHostReachability } from './host-reachability'
import { startDiagnosticFetchTimeout } from './diagnostic-fetch-timeout'
import { submitConnectionDiagnostics } from './connection-diagnostics-submission'
import type { DiagnosticsDeviceOperations } from './diagnostics-device-operations'

export function createNativeDiagnosticsOperations(
  host: HostProfile,
  context: RpcClientContextValue
): DiagnosticsDeviceOperations {
  return {
    async snapshot() {
      const snapshot = await readConnectionDiagnosticsSnapshot(context, connectionLogStore, host.id)
      return {
        ...snapshot,
        entries: snapshot.entries.slice(-200).map((entry) => {
          const redacted = redactConnectionLogEntry(entry)
          return {
            id: redacted.id.slice(0, 128),
            ts: redacted.ts,
            level: redacted.level,
            message: redacted.message.slice(0, 256),
            detail: redacted.detail?.slice(0, 256),
            code: redacted.code,
            path: redacted.path
          }
        }),
        endpointIsTailscale: isTailscaleEndpoint(host.endpoint),
        platform: `${Platform.OS} ${Platform.Version ?? ''}`.trim(),
        appVersion: Constants.expoConfig?.version ?? 'unknown',
        desktopAppVersion: await loadHostAppVersion(host.id),
        mobileWeb: { ...mobileWebDiagnosticsStore.get(host.id) }
      }
    },
    async probe(target) {
      if (target === 'host') {
        return { reachable: await testHostReachability(host.endpoint) }
      }
      const timeout = startDiagnosticFetchTimeout(5000)
      try {
        const response = await fetch('https://dns.google/resolve?name=example.com&type=A', {
          signal: timeout.signal
        })
        return { reachable: response.ok }
      } catch {
        return { reachable: false }
      } finally {
        timeout.dispose()
      }
    },
    submit: submitConnectionDiagnostics
  }
}
