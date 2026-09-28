import { beforeEach, expect, it, vi } from 'vitest'
import { WslDaemonOwnerAdmission } from './wsl-daemon-owner-admission'
import { proveWslDaemonIncarnationExited } from './wsl-daemon-incarnation'
import { startRetainedWslDaemonOwner } from './wsl-daemon-endpoint'
import type { WslDaemonRecovery } from '../../shared/wsl-daemon-recovery'
vi.mock('./wsl-daemon-incarnation', () => ({ proveWslDaemonIncarnationExited: vi.fn() }))
vi.mock('./wsl-daemon-endpoint', () => ({
  startRetainedWslDaemonOwner: vi.fn(),
  startPreparedWslDaemonOwner: vi.fn()
}))
const owner = { distro: 'Ubuntu', relayBuildId: 'old-build' }
const endpoint = {
  distro: 'Ubuntu',
  distributionId: 'distro',
  userName: 'alice',
  userId: '1000',
  home: '/home/alice',
  runtime: '/old/bun',
  entry: '/old/daemon-entry.js',
  envBinary: '/usr/bin/env',
  socket: '/old/socket',
  tokenPath: '/old/token',
  serverBuildId: 'old-build'
}
const prior = {
  pid: 42,
  startedAtMs: 100,
  launchNonce: 'old',
  linuxStartTicks: '123',
  bootId: 'boot'
}
const next = { ...prior, pid: 43, launchNonce: 'new', linuxStartTicks: '456' }
function setup(record?: WslDaemonRecovery) {
  const store = {
    getWslDaemonRecovery: vi.fn(() => record ?? null),
    upsertWslDaemonRecovery: vi.fn(async (value: WslDaemonRecovery) => {
      record = value
    })
  }
  const admission = new WslDaemonOwnerAdmission(
    store,
    owner,
    endpoint,
    new AbortController().signal
  )
  return { admission, store }
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(proveWslDaemonIncarnationExited).mockReset().mockResolvedValue(undefined)
})
it('gains proof by attaching to an identity-less record and admits before returning', async () => {
  const { admission, store } = setup({ kind: 'daemon', ...owner, endpoint })
  await admission.admitIdentity(prior)
  expect(store.upsertWslDaemonRecovery).toHaveBeenCalledWith(
    { kind: 'daemon', ...owner, endpoint, incarnation: prior },
    null
  )
  expect(proveWslDaemonIncarnationExited).not.toHaveBeenCalled()
})
it('refuses displaced but live prior owner even when the new hello authenticated', async () => {
  const { admission, store } = setup({ kind: 'daemon', ...owner, endpoint, incarnation: prior })
  vi.mocked(proveWslDaemonIncarnationExited).mockRejectedValueOnce(new Error('still live'))
  await expect(admission.admitIdentity(next)).rejects.toThrow('still live')
  expect(store.upsertWslDaemonRecovery).not.toHaveBeenCalled()
})
it('proves old incarnation exited before CAS admission of the new one', async () => {
  const { admission, store } = setup({ kind: 'daemon', ...owner, endpoint, incarnation: prior })
  await admission.admitIdentity(next)
  expect(proveWslDaemonIncarnationExited).toHaveBeenCalledWith(
    endpoint,
    prior,
    expect.any(AbortSignal)
  )
  expect(store.upsertWslDaemonRecovery).toHaveBeenCalledWith(
    { kind: 'daemon', ...owner, endpoint, incarnation: next },
    prior
  )
})
it('never starts another daemon after a durable admission failure', async () => {
  const { admission, store } = setup()
  store.upsertWslDaemonRecovery.mockRejectedValueOnce(new Error('disk full'))
  await expect(admission.establishLease(() => admission.admitIdentity(prior))).rejects.toThrow(
    'disk full'
  )
  expect(startRetainedWslDaemonOwner).not.toHaveBeenCalled()
})
it('passes the retained incarnation to the checked starter on cached-adapter recovery', async () => {
  const { admission } = setup({ kind: 'daemon', ...owner, endpoint, incarnation: prior })
  await admission.recover()
  expect(startRetainedWslDaemonOwner).toHaveBeenCalledWith(endpoint, prior, expect.any(AbortSignal))
  vi.mocked(startRetainedWslDaemonOwner).mockRejectedValueOnce(new Error('unverifiable'))
  await expect(admission.recover()).rejects.toThrow('unverifiable')
})
