import { describe, expect, it, vi } from 'vitest'
import {
  readHydratedConnectionLog,
  selectDiagnosticsHostId
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
})
