import { afterEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { getRemoteHostPlatform } from '../ssh-remote-platform'
import { unusedSshConnection } from '../unused-host-transport.test-fixture'

const TARGET = 'ssh-box'
const RELAY_PTY = 'pty2:epoch:1'
const PTY = toAppSshPtyId(TARGET, RELAY_PTY)

const relay = vi.hoisted(() => {
  const shutdowns: string[] = []
  return { ptys: new Set<string>(), shutdowns }
})

vi.mock('./legacy-relay-endpoints', () => ({
  listLegacyRelayEndpoints: async () => ({
    kind: 'listed',
    exhaustive: true,
    endpoints: [
      {
        endpoint: '/home/me/.orca-remote/relay-x.sock',
        connectCommand: 'node relay.js --connect',
        wrapCommand: true,
        host: getRemoteHostPlatform('linux-x64'),
        nodePath: 'node'
      }
    ]
  })
}))

vi.mock('./legacy-relay-client', () => ({
  LegacyRelayClient: {
    open: async () => {
      const exits = new Set<(id: string, code: number) => void>()
      return {
        ownerClaim: null,
        closed: false,
        list: async () => [...relay.ptys].map((relayPtyId) => ({ relayPtyId })),
        shutdown: async (id: string) => {
          relay.shutdowns.push(id)
          relay.ptys.delete(id)
          exits.forEach((listener) => listener(id, 0))
        },
        onData: () => () => {},
        onExit: (listener: (id: string, code: number) => void) => {
          exits.add(listener)
          return () => exits.delete(listener)
        },
        onClose: () => () => {},
        close: () => {}
      }
    }
  }
}))

const registry = await import('./legacy-relay-bridge-registry')

/** The persisted leases, which are all a restart keeps. */
let leases: SshRemotePtyLease[]
let connected: boolean

function installHost(): void {
  const connection = unusedSshConnection()
  registry.installLegacyRelayBridge({
    leases: () => leases,
    retireLease: (_target, relayPtyId) => {
      leases = leases.map((row) => {
        if (row.ptyId !== relayPtyId) {
          return row
        }
        const { pendingKill: _delivered, ...rest } = row
        return { ...rest, state: 'terminated' }
      })
    },
    recordStop: (_target, relayPtyId, pendingKill) => {
      leases = leases.map((row) => {
        if (row.ptyId !== relayPtyId) {
          return row
        }
        const { pendingKill: _dropped, ...rest } = row
        return pendingKill ? { ...rest, pendingKill } : rest
      })
    },
    connection: () => (connected ? connection : null),
    onPanesChanged: () => {},
    onData: () => {},
    onReplay: () => {},
    onExit: () => {},
    report: () => {}
  })
}

afterEach(() => {
  registry.installLegacyRelayBridge(null)
})

describe('a bridged tab closed while disconnected', () => {
  it('still stops its shell when Orca restarts before reconnecting', async () => {
    relay.ptys = new Set([RELAY_PTY])
    relay.shutdowns = []
    leases = [
      {
        targetId: TARGET,
        ptyId: RELAY_PTY,
        tabId: 'tab-1',
        leafId: 'leaf-1',
        state: 'detached',
        createdAt: 1,
        updatedAt: 1
      }
    ]
    connected = false
    installHost()
    await expect(registry.closeLegacyRelayPane(PTY)).resolves.toEqual({ status: 'unverifiable' })

    // Restart, then reconnect.
    installHost()
    await expect(registry.attachLegacyRelayPane(PTY)).resolves.toEqual({ status: 'not-bridged' })
    connected = true
    await registry.startLegacyRelayBridge(TARGET)

    expect(relay.shutdowns).toEqual([RELAY_PTY])
    expect(registry.legacyRelayBridgedPanes()).toEqual([])
    expect(leases[0].state).toBe('terminated')
    expect(leases[0].pendingKill).toBeUndefined()
  })
})
