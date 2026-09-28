import type * as StableOwner from './pty/pane/stable-owner'
import { afterEach, expect, it, vi } from 'vitest'
import { registerPtyHandlers } from './pty/register-handlers'
import { installPtySpawnIpcHandler } from './pty/ipc/spawn'
import { resolveStablePaneOwner } from './pty/pane/stable-owner'
import { registerWslPtyProvider } from './pty/provider/registry'
import { WslDaemonSessions } from '../wsl/wsl-daemon-sessions'
import { WslDaemonPtyProvider } from '../wsl/wsl-daemon-pty-provider'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'

vi.mock('./pty/ipc/spawn', () => ({ installPtySpawnIpcHandler: vi.fn() }))
vi.mock('./pty/pane/stable-owner', async (original) => ({
  ...(await original<typeof StableOwner>()),
  resolveStablePaneOwner: vi.fn()
}))
const releases: (() => void)[] = []
afterEach(() => {
  releases.splice(0).forEach((release) => release())
  vi.restoreAllMocks()
})

it('reconnects the persisted guest before the bound renderer adoption consults its registry', async () => {
  const owner = { distro: 'Ubuntu', relayBuildId: 'daemon+profile-user' }
  const id = toAppWslPtyId(owner, 'existing-shell')
  const binding = {
    ptyId: id,
    tabId: 'tab-restore',
    leafId: '44444444-4444-4444-8444-444444444444'
  }
  vi.mocked(resolveStablePaneOwner).mockReturnValue(binding)
  const endpoint = {
    distro: 'Ubuntu',
    distributionId: 'registration',
    userName: 'alice',
    userId: '1000',
    home: '/home/alice',
    runtime: '/bun',
    entry: '/daemon.js',
    envBinary: '/usr/bin/env',
    socket: '/socket',
    tokenPath: '/token',
    serverBuildId: 'artifact'
  }
  const adapter = new DaemonPtyAdapter({
    guest: {
      distro: 'Ubuntu',
      defaultShell: '/bin/bash',
      defaultCwd: '/home/alice',
      profiles: [],
      transport: {
        readToken: () => 'unused',
        connect: async () => {
          throw new Error('unexpected connector')
        }
      }
    }
  })
  const provider = new WslDaemonPtyProvider(owner, adapter)
  const spawn = vi.spyOn(provider, 'spawn').mockResolvedValue({ id, isReattach: true })
  const sessions = new WslDaemonSessions({
    profileScope: '/profile',
    historyRoot: '/history',
    store: {
      getWslDaemonRecovery: () => null,
      upsertWslDaemonRecovery: async () => {}
    }
  })
  const reconnect = vi.spyOn(sessions, 'reconnect').mockImplementation(async () => {
    releases.push(registerWslPtyProvider(owner, provider))
    return { owner, endpoint, provider }
  })
  registerPtyHandlers(undefined, undefined, undefined, undefined, undefined, undefined, {
    wslDaemonSessions: sessions
  })
  const deps = vi.mocked(installPtySpawnIpcHandler).mock.calls.at(-1)?.[0]
  expect(deps).toBeDefined()
  const result = await deps?.adoptStablePane({
    ...binding,
    worktreeId: 'repo::/workspace',
    cols: 91,
    rows: 31,
    ownsPaneSpawnReservation: true
  })
  expect(reconnect).toHaveBeenCalledWith(expect.objectContaining(owner))
  expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id, attachOnly: true }))
  expect(reconnect.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0])
  expect(result?.result.id).toBe(id)
  adapter.dispose()
})
