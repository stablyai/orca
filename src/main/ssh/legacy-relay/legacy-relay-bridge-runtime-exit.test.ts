/**
 * A bridged terminal's exit is proven only by the old relay, and the runtime has no provider
 * listener for it: the bridge must tell the runtime itself, whichever route closed the tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { SshConnection } from '../connection/ssh-connection'
import { getRemoteHostPlatform } from '../ssh-remote-platform'
import type { PtyRuntimeControllerDeps } from '../../ipc/pty/runtime/controller-deps'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { LEGACY_RELAY_BRIDGE_CHANNELS } from '../../../shared/legacy-relay-bridge-contract'

const TARGET = 'ssh-box'
const RELAY_PTY = 'pty2:epoch:1'
const PTY = toAppSshPtyId(TARGET, RELAY_PTY)

const relay = vi.hoisted(() => ({
  ptys: new Set<string>(),
  exits: new Set<(id: string, code: number) => void>()
}))

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) =>
      ipc.handlers.set(channel, handler),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn()
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
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
    open: async () => ({
      ownerClaim: null,
      closed: false,
      list: async () => [...relay.ptys].map((relayPtyId) => ({ relayPtyId })),
      shutdown: async (id: string) => {
        relay.ptys.delete(id)
        relay.exits.forEach((listener) => listener(id, 0))
      },
      onData: () => () => {},
      onExit: (listener: (id: string, code: number) => void) => {
        relay.exits.add(listener)
        return () => relay.exits.delete(listener)
      },
      onClose: () => () => {},
      close: () => {}
    })
  }
}))

const registry = await import('./legacy-relay-bridge-registry')
const { registerLegacyRelayBridgeIpc } = await import('./legacy-relay-bridge-ipc')
const { killPtyFromRuntimeController, stopAndWaitPtyFromRuntimeController } =
  await import('../../ipc/pty/runtime/kill')

let leases: SshRemotePtyLease[]
let runtime: {
  onPtyExit: ReturnType<typeof vi.fn>
  markPtyLivenessUnverifiable: ReturnType<typeof vi.fn>
  markPtyStopRequested: ReturnType<typeof vi.fn>
}

async function startBridge(): Promise<void> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked endpoints and client never touch the connection.
  const connection = {} as SshConnection
  registerLegacyRelayBridgeIpc({
    store: {
      getSshRemotePtyLeases: () => leases,
      markSshRemotePtyLease: (_target: string, relayPtyId: string) => {
        leases = leases.map((row) =>
          row.ptyId === relayPtyId ? { ...row, state: 'terminated' } : row
        )
      },
      setSshRemotePtyLeasePendingKill: (_target: string, relayPtyId: string, pendingKill) => {
        leases = leases.map((row) => {
          if (row.ptyId !== relayPtyId) {
            return row
          }
          const { pendingKill: _dropped, ...rest } = row
          return pendingKill ? { ...rest, pendingKill } : rest
        })
      },
      getSshTarget: () => undefined
    },
    getMainWindow: () => null,
    connection: () => connection,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only these runtime methods.
    runtime: () => runtime as unknown as OrcaRuntimeService
  })
  await registry.startLegacyRelayBridge(TARGET)
}

function controllerDeps(): PtyRuntimeControllerDeps {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridged branches read only these deps.
  return {
    runtime,
    store: null,
    getLocalPtyProviderStartupPromise: () => null,
    shutdownProviderAndDetectExit: vi.fn(),
    finishPtyShutdown: vi.fn(() => undefined),
    rememberSyntheticKillExit: vi.fn(),
    sendPtyExitToRenderer: vi.fn(),
    retiredRejectedPtyIds: new Map()
  } as unknown as PtyRuntimeControllerDeps
}

beforeEach(() => {
  relay.ptys = new Set([RELAY_PTY])
  relay.exits.clear()
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
  runtime = {
    onPtyExit: vi.fn(),
    markPtyLivenessUnverifiable: vi.fn(),
    markPtyStopRequested: vi.fn()
  }
})

afterEach(() => {
  registry.installLegacyRelayBridge(null)
})

describe('a bridged terminal the old relay proves exited', () => {
  it('reaches the runtime when a kill closed its tab', async () => {
    await startBridge()

    expect(killPtyFromRuntimeController(controllerDeps(), PTY)).toBe(true)
    await vi.waitFor(() => expect(leases[0].state).toBe('terminated'))

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
    expect(runtime.onPtyExit).toHaveBeenCalledWith(PTY, 0, undefined, { hostExitConfirmed: true })
  })

  it('reaches the runtime when its shell exits on its own', async () => {
    await startBridge()

    relay.ptys.delete(RELAY_PTY)
    relay.exits.forEach((listener) => listener(RELAY_PTY, 3))

    expect(runtime.onPtyExit).toHaveBeenCalledWith(PTY, 3, undefined, { hostExitConfirmed: true })
  })

  it('reaches the runtime once from a stop-and-wait, not again from the stop', async () => {
    await startBridge()

    await expect(
      stopAndWaitPtyFromRuntimeController(controllerDeps(), PTY, {
        deadlineMs: Date.now() + 5_000
      })
    ).resolves.toBe(true)

    expect(runtime.onPtyExit).toHaveBeenCalledTimes(1)
  })

  it('records a renderer bridge close as a deliberate stop before sending it', async () => {
    await startBridge()

    await ipc.handlers.get(LEGACY_RELAY_BRIDGE_CHANNELS.close)?.({}, { ptyId: PTY })

    expect(runtime.markPtyStopRequested).toHaveBeenCalledWith(PTY)
    expect(runtime.markPtyStopRequested.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.onPtyExit.mock.invocationCallOrder[0]
    )
  })

  it('reports a proven absence as an exit with no status, never an unconfirmed stop', async () => {
    await startBridge()

    // Every relay answers and none holds it: proof, though no exit code was reported.
    relay.ptys.delete(RELAY_PTY)
    await registry.startLegacyRelayBridge(TARGET)

    expect(runtime.onPtyExit).toHaveBeenCalledWith(PTY, -1, undefined, {
      hostExitConfirmed: true,
      cause: { kind: 'unknown', reason: 'cause_unreported' }
    })
  })
})
