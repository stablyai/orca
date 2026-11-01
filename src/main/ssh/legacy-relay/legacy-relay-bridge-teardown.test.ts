import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayTargetBridgeDeps } from './legacy-relay-target-bridge'
import type { LegacyRelayBridgeHost } from './legacy-relay-bridge-registry'
import { unusedSshConnection } from '../unused-host-transport.test-fixture'

const TARGET = 'ssh-box'
const PTY = toAppSshPtyId(TARGET, 'pty-1')

const renderer = vi.hoisted(() => ({
  listeners: new Set<(panes: LegacyRelayBridgedPane[]) => void>()
}))

// The bridge's relay listing is out of scope: this one lists the leased pane live on refresh.
vi.mock('./legacy-relay-target-bridge', () => ({
  LegacyRelayTargetBridge: class {
    private listed: LegacyRelayBridgedPane[] = []
    constructor(private readonly deps: LegacyRelayTargetBridgeDeps) {}
    snapshot(): LegacyRelayBridgedPane[] {
      return this.listed
    }
    livePaneCount(): number {
      return this.listed.length
    }
    async refresh(): Promise<void> {
      this.listed = this.deps.leases().map((row) => ({
        ptyId: toAppSshPtyId(this.deps.targetId, row.ptyId),
        targetId: this.deps.targetId,
        tabId: row.tabId ?? '',
        ...(row.leafId ? { leafId: row.leafId } : {}),
        state: 'live' as const
      }))
      this.deps.onPanesChanged()
    }
    async attach(_ptyId: string, atSnapshot?: (replay: string) => void) {
      atSnapshot?.('SCREEN')
      return { status: 'attached' as const, replay: 'SCREEN' }
    }
    dispose(): void {
      this.listed = []
      this.deps.onPanesChanged()
    }
  }
}))

vi.stubGlobal('window', {
  api: {
    legacyRelayBridge: {
      listPanes: async () => [],
      onPanes: (listener: (panes: LegacyRelayBridgedPane[]) => void) => {
        renderer.listeners.add(listener)
        return () => renderer.listeners.delete(listener)
      }
    }
  }
})

const registry = await import('./legacy-relay-bridge-registry')
const { legacyRelayBridgePtyIdForPane } =
  await import('../../../renderer/src/components/terminal-pane/legacy-relay-bridge-panes')

let leases: SshRemotePtyLease[]
let report: Mock<LegacyRelayBridgeHost['report']>

function lease(): SshRemotePtyLease {
  return {
    targetId: TARGET,
    ptyId: 'pty-1',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    state: 'detached',
    createdAt: 1,
    updatedAt: 1
  }
}

beforeEach(async () => {
  leases = [lease()]
  report = vi.fn()
  registry.installLegacyRelayBridge({
    leases: () => leases,
    retireLease: vi.fn(),
    recordStop: vi.fn(),
    connection: () => null,
    // Main publishes to the window as legacy-relay-bridge-ipc.ts does.
    onPanesChanged: (panes) => renderer.listeners.forEach((listener) => listener(panes)),
    onData: vi.fn(),
    onReplay: vi.fn(),
    onExit: vi.fn(),
    report
  })
  await registry.startLegacyRelayBridge(TARGET)
})

describe('a hung-up legacy relay bridge (loss of contact is not exit)', () => {
  it('keeps the panes it served as unverifiable while their leases are held', () => {
    registry.stopLegacyRelayBridge(TARGET)

    expect(registry.legacyRelayBridgedPanes()).toEqual([
      { ptyId: PTY, targetId: TARGET, tabId: 'tab-1', leafId: 'leaf-1', state: 'unverifiable' }
    ])
  })

  it('empties the list once the target and its leases are removed', () => {
    registry.stopLegacyRelayBridge(TARGET)
    expect(registry.legacyRelayBridgedPanes()).toHaveLength(1)

    leases = []
    registry.forgetLegacyRelayTarget(TARGET)

    expect(registry.legacyRelayBridgedPanes()).toEqual([])
  })

  it('publishes an empty list when the next connect finds the leases retired', async () => {
    registry.stopLegacyRelayBridge(TARGET)
    const published: LegacyRelayBridgedPane[][] = []
    const record = (panes: LegacyRelayBridgedPane[]): void => void published.push(panes)
    renderer.listeners.add(record)

    leases = []
    await registry.startLegacyRelayBridge(TARGET)
    renderer.listeners.delete(record)

    expect(published.at(-1)).toEqual([])
  })

  it('still sends a pane that remounts during the reconnect gap to the bridge', () => {
    // Disconnect, then the pane's transport is rebuilt before the next connect starts a bridge.
    registry.stopLegacyRelayBridge(TARGET)

    expect(
      legacyRelayBridgePtyIdForPane({
        tabId: 'web-terminal-tab-1',
        leafId: 'leaf-1',
        boundPtyId: null
      })
    ).toBe(PTY)
  })
})

describe('attaching a bridged pane', () => {
  it('sends a reattach screen in output order and only once', async () => {
    const replays: string[] = []
    const connection = unusedSshConnection()
    registry.installLegacyRelayBridge({
      leases: () => leases,
      retireLease: vi.fn(),
      recordStop: vi.fn(),
      connection: () => connection,
      onPanesChanged: vi.fn(),
      onData: vi.fn(),
      onReplay: (_ptyId, replay) => replays.push(replay),
      onExit: vi.fn(),
      report: vi.fn()
    })
    await expect(registry.attachLegacyRelayPane(PTY)).resolves.toEqual({
      status: 'attached',
      replay: 'SCREEN'
    })
    expect(replays).toEqual([])
    await expect(registry.attachLegacyRelayPane(PTY, true)).resolves.toEqual({
      status: 'attached',
      replay: ''
    })
    expect(replays).toEqual(['SCREEN'])
  })
})
