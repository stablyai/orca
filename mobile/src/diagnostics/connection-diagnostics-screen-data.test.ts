import { describe, expect, it } from 'vitest'
import {
  resolveDiagnosticsHostId,
  selectDiagnosticsHostId
} from './connection-diagnostics-screen-data'

import type { HostProfile } from '../transport/hosts/host-profile'

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
})
