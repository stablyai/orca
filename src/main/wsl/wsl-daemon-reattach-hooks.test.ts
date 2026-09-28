import { beforeEach, expect, it, vi } from 'vitest'
import { prepareWslDaemonReattachHooks } from './wsl-daemon-reattach-hooks'
import { wslHookRelayManager } from '../agent-hooks/wsl-hook-relay-manager'
import { toAppWslPtyId } from '../../shared/wsl-pty-id'
import type { WslDaemonConnection } from './wsl-daemon-sessions'

vi.mock('../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: { ensureForDistro: vi.fn(async () => {}) }
}))
beforeEach(() => vi.clearAllMocks())

it('restarts hooks as the persisted user rather than the current default', async () => {
  const owner = { distro: 'Ubuntu', relayBuildId: 'retained-owner' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Hook preparation reads only endpoint.distro and endpoint.userName from this connection.
  const connection = { endpoint: { distro: 'Ubuntu', userName: 'root' } } as WslDaemonConnection
  const reconnect = vi.fn(async () => connection)
  const result = { id: toAppWslPtyId(owner, 'retained'), isReattach: true }
  await expect(
    prepareWslDaemonReattachHooks({ result, sessions: { reconnect }, hooksEnabled: true })
  ).resolves.toBe(true)
  expect(reconnect).toHaveBeenCalledWith({ ...owner, relayPtyId: 'retained' })
  expect(wslHookRelayManager.ensureForDistro).toHaveBeenCalledWith(
    'Ubuntu',
    undefined,
    undefined,
    'root'
  )
})

it('does not prepare hooks for disabled hooks or a fresh guest spawn', async () => {
  const id = toAppWslPtyId({ distro: 'Ubuntu', relayBuildId: 'owner' }, 'terminal')
  await expect(
    prepareWslDaemonReattachHooks({ result: { id, isReattach: true }, hooksEnabled: false })
  ).resolves.toBe(true)
  await expect(prepareWslDaemonReattachHooks({ result: { id }, hooksEnabled: true })).resolves.toBe(
    true
  )
  expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
})

it('does not delay an already-live attach on unavailable hook preparation', async () => {
  const reconnect = vi.fn(() => new Promise<WslDaemonConnection>(() => {}))
  const id = toAppWslPtyId({ distro: 'Ubuntu', relayBuildId: 'owner' }, 'terminal')
  await expect(
    prepareWslDaemonReattachHooks({
      result: { id, isReattach: true },
      sessions: { reconnect },
      hooksEnabled: true
    })
  ).resolves.toBe(true)
  expect(wslHookRelayManager.ensureForDistro).not.toHaveBeenCalled()
})
