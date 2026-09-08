import { describe, expect, it, vi } from 'vitest'
import { createNativeDiagnosticsOperations } from './native-diagnostics-operations'
import { readConnectionDiagnosticsSnapshot } from './connection-diagnostics-screen-data'
import type { HostProfile } from '../transport/types'
import type { RpcClientContextValue } from '../transport/rpc-client-context-contract'
import { DiagnosticsSnapshotResultSchema } from '../../../src/shared/mobile-web/diagnostics-device-contract'

vi.mock('react-native', () => ({ Platform: { OS: 'android', Version: 32 } }))
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.0' } } }))
vi.mock('../transport/persisted-connection-log-store', () => ({ connectionLogStore: {} }))
vi.mock('../transport/host-app-version-store', () => ({
  loadHostAppVersion: vi.fn().mockResolvedValue('2.0')
}))
vi.mock('./connection-diagnostics-screen-data', () => ({
  readConnectionDiagnosticsSnapshot: vi.fn()
}))

describe('native diagnostics snapshot', () => {
  it('reads only the bound host and redacts secrets before truncating bounded event history', async () => {
    const host = {
      id: 'private-host',
      endpoint: 'ws://100.64.0.1:4000',
      publicKeyB64: 'private-key',
      deviceToken: 'private-token'
    } as HostProfile
    const context = {} as RpcClientContextValue
    vi.mocked(readConnectionDiagnosticsSnapshot).mockResolvedValue({
      state: 'disconnected',
      reconnectAttempts: 2,
      lastConnectedAt: null,
      activePath: 'lan',
      pendingPath: null,
      entries: Array.from({ length: 240 }, (_, i) => ({
        id: `event-${i}`,
        ts: i,
        level: 'error',
        message: 'deviceToken=secret-token ' + '🙂'.repeat(2048),
        detail: 'wss://user:password@example.com/?token=secret-query'
      }))
    })
    const snapshot = await createNativeDiagnosticsOperations(host, context).snapshot()
    expect(readConnectionDiagnosticsSnapshot).toHaveBeenCalledWith(context, {}, 'private-host')
    expect(snapshot.entries).toHaveLength(200)
    expect(snapshot.entries[0]?.id).toBe('event-40')
    expect(snapshot.endpointIsTailscale).toBe(true)
    const encoded = JSON.stringify(snapshot)
    for (const secret of [
      'private-host',
      'private-key',
      'private-token',
      'secret-token',
      'password',
      'secret-query',
      '100.64.0.1'
    ]) {
      expect(encoded).not.toContain(secret)
    }
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(512 * 1024)
    expect(DiagnosticsSnapshotResultSchema.safeParse(snapshot).success).toBe(true)
  })
})
