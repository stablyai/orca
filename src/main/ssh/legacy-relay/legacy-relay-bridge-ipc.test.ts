import { describe, expect, it, vi } from 'vitest'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { LEGACY_RELAY_BRIDGE_CHANNELS } from '../../../shared/legacy-relay-bridge-contract'

const handlers = vi.hoisted(() => new Map<string, () => unknown>())

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

const { registerLegacyRelayBridgeIpc } = await import('./legacy-relay-bridge-ipc')

function lease(targetId: string): SshRemotePtyLease {
  return {
    targetId,
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    state: 'detached',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('the bridged-pane list before any host connects (#37840)', () => {
  it("names a kept target's leased pane but not a removed target's stale lease", () => {
    const leases = [lease('kept'), lease('removed')]
    registerLegacyRelayBridgeIpc({
      store: {
        getSshRemotePtyLeases: (targetId?: string) =>
          leases.filter((row) => targetId === undefined || row.targetId === targetId),
        markSshRemotePtyLease: vi.fn(),
        setSshRemotePtyLeasePendingKill: vi.fn(),
        getSshTarget: (id: string) =>
          id === 'kept' ? { id, label: id, host: id, port: 22, username: 'u' } : undefined
      },
      getMainWindow: () => null,
      connection: () => null
    })

    const panes = handlers.get(LEGACY_RELAY_BRIDGE_CHANNELS.listPanes)?.()

    expect(panes).toEqual([
      {
        ptyId: 'ssh:kept@@pty-1',
        targetId: 'kept',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        state: 'unverifiable'
      }
    ])
  })
})
