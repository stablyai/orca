import { describe, expect, it, vi } from 'vitest'
import {
  getDiagnosticsSubmissionState,
  readConnectionDiagnosticsSnapshot,
  readHydratedConnectionLog,
  resolveDiagnosticsHostId,
  selectDiagnosticsHostId,
  updateDiagnosticsSubmissionState
} from './connection-diagnostics-screen-data'
import type { ConnectionLogEntry, HostProfile } from '../transport/types'

const host = (id: string): HostProfile => ({
  id,
  name: id,
  endpoint: 'ws://192.168.1.2:6768',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
})

describe('connection diagnostics screen data', () => {
  it('prefers a valid route host when navigation changes', () => {
    expect(selectDiagnosticsHostId([host('a'), host('b')], 'b', 'a')).toBe('b')
    expect(selectDiagnosticsHostId([host('a')], 'missing', 'missing')).toBe('a')
  })

  it('applies route changes synchronously without discarding a chip choice for the same route', () => {
    const hosts = [host('a'), host('b')]
    expect(resolveDiagnosticsHostId(hosts, undefined, null)).toBe('a')
    expect(resolveDiagnosticsHostId(hosts, 'b', { hostId: 'a', requestedHostId: 'a' })).toBe('b')
    expect(resolveDiagnosticsHostId(hosts, 'b', { hostId: 'a', requestedHostId: 'b' })).toBe('a')
  })

  it('does not revive a stale manual choice when routing away and back', () => {
    const hosts = [host('a'), host('b'), host('c')]
    const firstRouteA = {}
    const routeC = {}
    const secondRouteA = {}
    const manualSelection = { hostId: 'b', requestedHostId: 'a', routeKey: firstRouteA }

    expect(resolveDiagnosticsHostId(hosts, 'c', manualSelection, routeC)).toBe('c')
    expect(resolveDiagnosticsHostId(hosts, 'a', manualSelection, secondRouteA)).toBe('a')
  })

  it('keeps async submission completion scoped to its host incident', () => {
    let states = updateDiagnosticsSubmissionState({}, 'host-a:incident-1', 'sending')
    states = updateDiagnosticsSubmissionState(states, 'host-b:incident-2', 'sending')
    states = updateDiagnosticsSubmissionState(states, 'host-a:incident-1', 'sent')

    expect(getDiagnosticsSubmissionState(states, 'host-a:incident-1')).toBe('sent')
    expect(getDiagnosticsSubmissionState(states, 'host-b:incident-2')).toBe('sending')
  })

  it('waits for hydration and then reads the refreshed log', async () => {
    const entries: ConnectionLogEntry[] = []
    const store = {
      hydrate: vi.fn(async () => {
        entries.push({ id: 'stored', ts: 1, level: 'info', message: 'stored event' })
      }),
      get: vi.fn(() => entries)
    }

    await expect(readHydratedConnectionLog(store, 'host-a')).resolves.toEqual(entries)
    expect(store.get).toHaveBeenCalledAfter(store.hydrate)
  })

  it('retries one transient hydration failure before reading', async () => {
    const entries = [{ id: 'stored', ts: 1, level: 'info' as const, message: 'stored event' }]
    const store = {
      hydrate: vi
        .fn()
        .mockRejectedValueOnce(new Error('storage unavailable'))
        .mockResolvedValueOnce(undefined),
      get: vi.fn(() => entries)
    }

    await expect(readHydratedConnectionLog(store, 'host-a')).resolves.toEqual(entries)
    expect(store.hydrate).toHaveBeenCalledTimes(2)
  })

  it('reads connection metadata after hydration completes', async () => {
    let state: 'connecting' | 'reconnecting' = 'connecting'
    const store = {
      hydrate: vi.fn(async () => {
        state = 'reconnecting'
      }),
      get: vi.fn(() => [{ id: 'new', ts: 2, level: 'warn' as const, message: 'new event' }])
    }
    const context = {
      getState: vi.fn(() => state),
      getReconnectAttempt: vi.fn(() => 2),
      getLastConnectedAt: vi.fn(() => 1),
      getActivePath: vi.fn(() => 'relay' as const),
      getPendingPath: vi.fn(() => null)
    }

    await expect(readConnectionDiagnosticsSnapshot(context, store, 'host-a')).resolves.toEqual({
      state: 'reconnecting',
      reconnectAttempts: 2,
      lastConnectedAt: 1,
      activePath: 'relay',
      pendingPath: null,
      entries: [{ id: 'new', ts: 2, level: 'warn', message: 'new event' }]
    })
    expect(context.getState).toHaveBeenCalledAfter(store.hydrate)
  })
})
