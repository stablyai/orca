import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps } from './ssh-relay-session-test-fixtures'
import { registerSshPtyProvider, unregisterSshPtyProvider } from '../ipc/pty/provider/registry'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshConnection } from './ssh-connection'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const dispose of cleanup.splice(0)) {
    dispose()
  }
})
let generation = 6000000
function fixture() {
  const deps = createMockDeps()
  const targetId = randomUUID()
  const providerGeneration = ++generation
  const pty = { providerGeneration, dispose: vi.fn() }
  const filesystem = { dispose: vi.fn() }
  registerSshPtyProvider(targetId, pty as never)
  registerSshFilesystemProvider(targetId, filesystem as never)
  registerSshGitProvider(targetId, {} as never)
  cleanup.push(() => {
    unregisterSshPtyProvider(targetId)
    unregisterSshFilesystemProvider(targetId)
    unregisterSshGitProvider(targetId)
  })
  const session = new SshRelaySession(
    targetId,
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  const mux = {
    dispose: vi.fn(),
    isDisposed: vi.fn(() => false),
    fenceForRelayReset: vi.fn(),
    assertRelayResetAcknowledgmentDrained: vi.fn()
  }
  const releaseWatcher = vi.fn()
  const state = session as unknown as {
    _state: string
    mux: SshChannelMultiplexer | null
    currentConnection: SshConnection | null
    activePtyProviderGeneration: number | null
    muxDisposeCleanup: (() => void) | null
  }
  state._state = 'ready'
  state.mux = mux as unknown as SshChannelMultiplexer
  state.currentConnection = deps.mockConn
  state.activePtyProviderGeneration = providerGeneration
  state.muxDisposeCleanup = releaseWatcher
  return { ...deps, session, state, mux, releaseWatcher, pty, filesystem }
}

it('requires captured network admission and the exact ACK gate even for an empty cohort', () => {
  const f = fixture()
  const retirement = f.session.captureResetRetirement()
  const request = {
    version: 1 as const,
    operationId: 'reset',
    runtimeIncarnation: 'runtime',
    ownerGeneration: 1,
    ownerLease: 'lease'
  }
  expect(() => retirement.confirmNetworkResetRetirement(request)).toThrow('not_fenced')
  retirement.begin()
  f.mux.assertRelayResetAcknowledgmentDrained.mockImplementationOnce(() => {
    throw new Error('not in ACK context')
  })
  expect(() => retirement.confirmNetworkResetRetirement(request)).toThrow('not in ACK context')
  retirement.confirmNetworkResetRetirement(request)
  expect(f.mux.assertRelayResetAcknowledgmentDrained).toHaveBeenLastCalledWith(request)
  retirement.assertNetworkTunnelsDrained()
})

it('latches reset before transport close and retires only captured local resources', async () => {
  const f = fixture()
  const migration = vi.fn()
  Object.assign(f.session, {
    activePtyConsumerOwner: () => ({ outputFlowControl: true }),
    beginPtyModelMigration: migration
  })
  const retirement = f.session.captureResetRetirement()
  retirement.begin()
  retirement.assertIdentity()
  expect(f.releaseWatcher).toHaveBeenCalledOnce()
  expect(f.mux.fenceForRelayReset).toHaveBeenCalledOnce()
  expect(f.session.isResetRetirementPending()).toBe(true)
  await expect(f.session.reconnect(f.mockConn)).rejects.toThrow('pending')
  await expect(f.session.detachAndPersist()).rejects.toThrow('pending')
  await expect(f.session.disposeAndPersist()).rejects.toThrow('pending')
  f.session.beginShutdownDetach()
  f.mux.isDisposed.mockReturnValue(true)
  retirement.retire(() => {})
  retirement.assertRetired()
  retirement.assertIdentity()
  retirement.retire(() => {})
  expect(f.pty.dispose).toHaveBeenCalledOnce()
  expect(f.filesystem.dispose).toHaveBeenCalledOnce()
  expect(f.mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
  expect(f.mockStore.markSshRemotePtyLeasesForShutdown).not.toHaveBeenCalled()
  expect(f.mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
  expect(f.mockPortForward.removeAllForwards).not.toHaveBeenCalled()
  expect(f.mockWindow.webContents.send).not.toHaveBeenCalled()
  expect(migration).not.toHaveBeenCalled()
})

it('releases relay-loss watcher and fences work before scanner cancellation', () => {
  const f = fixture()
  const order: string[] = []
  f.releaseWatcher.mockImplementation(() => {
    order.push('watcher')
  })
  f.mux.fenceForRelayReset.mockImplementation(() => {
    order.push('fence')
  })
  Object.assign(f.session, {
    portScanner: {
      stopScanning: () => {
        expect(f.session.isResetRetirementPending()).toBe(true)
        order.push('scanner')
      }
    }
  })
  f.session.captureResetRetirement().begin()
  expect(order).toEqual(['watcher', 'fence', 'scanner'])
})

it('refuses a replacement connection without touching captured providers', () => {
  const f = fixture()
  const retirement = f.session.captureResetRetirement()
  retirement.begin()
  f.state.currentConnection = {} as SshConnection
  expect(() => retirement.retire(() => {})).toThrow('changed')
  expect(f.pty.dispose).not.toHaveBeenCalled()
  expect(f.mux.dispose).not.toHaveBeenCalled()
})

it('retries partial cleanup without bulk lease mutation', () => {
  const f = fixture()
  const retirement = f.session.captureResetRetirement()
  retirement.begin()
  f.filesystem.dispose.mockImplementationOnce(() => {
    throw new Error('retry')
  })
  expect(() => retirement.retire(() => {})).toThrow('retry')
  retirement.retire(() => {})
  retirement.assertRetired()
  expect(f.pty.dispose).toHaveBeenCalledOnce()
  expect(f.mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
})

it('refuses a competing capture once another reset begins', () => {
  const f = fixture()
  const first = f.session.captureResetRetirement()
  const second = f.session.captureResetRetirement()
  first.begin()
  expect(() => second.begin()).toThrow('changed')
  expect(() => f.session.captureResetRetirement()).toThrow('uncaptured')
  expect(f.pty.dispose).not.toHaveBeenCalled()
})

it('rechecks authority after transport disposal before provider disposal', () => {
  const f = fixture()
  const retirement = f.session.captureResetRetirement()
  retirement.begin()
  let authorized = true
  f.mux.dispose.mockImplementation(() => {
    authorized = false
  })
  expect(() =>
    retirement.retire(() => {
      if (!authorized) {
        throw new Error('authority')
      }
    })
  ).toThrow('authority')
  expect(f.pty.dispose).not.toHaveBeenCalled()
  expect(f.filesystem.dispose).not.toHaveBeenCalled()
  retirement.retire(() => {})
  retirement.assertRetired()
})
