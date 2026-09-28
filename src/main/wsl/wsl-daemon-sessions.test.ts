import { beforeEach, expect, it, vi } from 'vitest'
import { parseAppWslPtyId, toAppWslPtyId } from '../../shared/wsl-pty-id'
import { WslDaemonSessions } from './wsl-daemon-sessions'
import type { WslDaemonRecovery } from '../../shared/wsl-daemon-recovery'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import { prepareWslDaemonEndpoint, startPreparedWslDaemonOwner } from './wsl-daemon-endpoint'
import { createWslDaemonTransport } from './wsl-daemon-transport'
import { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import { registerWslPtyProvider } from '../ipc/pty/provider/registry'
import { readWslDistributionIdentity } from './wsl-distribution-identity'

const { lease, detach, unregister, run } = vi.hoisted(() => ({
  lease: vi.fn(),
  detach: vi.fn(),
  unregister: vi.fn(),
  run: vi.fn()
}))
vi.mock('../daemon/daemon-pty-adapter', () => ({
  DaemonPtyAdapter: vi.fn(
    class {
      constructor(private readonly options: ConstructorParameters<typeof DaemonPtyAdapter>[0]) {}
      establishLifecycleLease = async () => {
        await lease()
        await this.options.guest?.admitIdentity?.(null)
      }
      disconnectOnly = detach
    }
  )
}))
vi.mock('../ipc/pty/provider/registry', () => ({ registerWslPtyProvider: vi.fn(() => unregister) }))
vi.mock('./wsl-daemon-endpoint', () => ({
  prepareWslDaemonEndpoint: vi.fn(),
  startPreparedWslDaemonOwner: vi.fn(),
  startRetainedWslDaemonOwner: vi.fn(async () => {
    throw new Error('owner unverifiable')
  })
}))
vi.mock('./wsl-daemon-transport', () => ({ createWslDaemonTransport: vi.fn(() => ({})) }))
vi.mock('./wsl-bun-runtime', () => ({ createRunningWslRuntimeRunner: vi.fn(() => ({ run })) }))
vi.mock('./wsl-distribution-identity', () => ({ readWslDistributionIdentity: vi.fn() }))
const owner = { distro: 'Ubuntu', relayBuildId: 'daemon+artifact+profile-user' }
const endpoint = {
  distro: 'Ubuntu',
  distributionId: 'registration',
  userName: 'alice',
  userId: '1000',
  home: '/home/alice',
  envBinary: '/usr/bin/env',
  runtime: '/bin/bun',
  entry: '/daemon.js',
  socket: '/private/socket',
  tokenPath: '/private/token',
  serverBuildId: 'artifact'
}
const prepared = { owner, endpoint, entry: '/daemon.js', path: '/bin', artifactId: 'artifact' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function setup(record: WslDaemonRecovery | null = null) {
  const store = {
    getWslDaemonRecovery: vi.fn(() => record),
    upsertWslDaemonRecovery: vi.fn(async (value: WslDaemonRecovery) => {
      record = value
    })
  }
  return {
    store,
    sessions: new WslDaemonSessions({ store, profileScope: '/profile', historyRoot: '/history' })
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  lease.mockReset().mockResolvedValue(undefined)
  detach.mockReset().mockResolvedValue(undefined)
  run.mockReset().mockResolvedValue('/bin/bash')
  vi.mocked(prepareWslDaemonEndpoint).mockReset().mockResolvedValue(prepared)
  vi.mocked(startPreparedWslDaemonOwner).mockReset().mockResolvedValue(undefined)
  vi.mocked(readWslDistributionIdentity).mockResolvedValue('registration')
})

it('coalesces preparation and publishes only after durable owner admission', async () => {
  const { store, sessions } = setup()
  const persisted = deferred<void>()
  store.upsertWslDaemonRecovery.mockReturnValue(persisted.promise)
  const first = sessions.prepareFresh('Ubuntu')
  const second = sessions.prepareFresh('ubuntu')
  await vi.waitFor(() => expect(store.upsertWslDaemonRecovery).toHaveBeenCalledOnce())
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  persisted.resolve()
  const [a, b] = await Promise.all([first, second])
  expect(a).toBe(b)
  expect(Object.isFrozen(a.execution)).toBe(true)
  expect(a.execution).toEqual({
    distro: 'Ubuntu',
    userName: 'alice',
    userId: '1000',
    home: '/home/alice'
  })
  expect(prepareWslDaemonEndpoint).toHaveBeenCalledOnce()
  expect(registerWslPtyProvider).toHaveBeenCalledOnce()
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  expect(DaemonPtyAdapter).toHaveBeenCalledWith(
    expect.objectContaining({
      historyPath: expect.stringMatching(/history[/\\][a-f0-9]{64}$/),
      guest: expect.objectContaining({ defaultShell: '/bin/bash', defaultCwd: '/home/alice' })
    })
  )
  await sessions.dispose()
})

it('reconnects only the persisted explicit owner without preparing or starting', async () => {
  const { sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  const [a, b] = await Promise.all([sessions.reconnect(owner), sessions.reconnect(owner)])
  expect(a).toBe(b)
  expect(createWslDaemonTransport).toHaveBeenCalledWith(endpoint)
  expect(run.mock.lastCall?.[0].args).toEqual(
    expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
  )
  expect(createRunningWslRuntimeRunner).toHaveBeenCalledWith(
    'Ubuntu',
    expect.any(AbortSignal),
    'alice'
  )
  expect(prepareWslDaemonEndpoint).not.toHaveBeenCalled()
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  await sessions.dispose()
})

it('delegates failed fresh contact to the safe starter, but never starts on durable-write failure', async () => {
  lease.mockRejectedValueOnce(new Error('missing endpoint'))
  const { store, sessions } = setup()
  store.upsertWslDaemonRecovery.mockRejectedValueOnce(new Error('disk full'))
  await expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('disk full')
  expect(startPreparedWslDaemonOwner).toHaveBeenCalledOnce()
  expect(lease).toHaveBeenCalledTimes(2)
  expect(detach).toHaveBeenCalledOnce()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  await sessions.dispose()
})

it('does not retry or publish when the fresh owner cannot be verified by the starter', async () => {
  lease.mockRejectedValueOnce(new Error('missing endpoint'))
  vi.mocked(startPreparedWslDaemonOwner).mockRejectedValueOnce(new Error('owner unverifiable'))
  const { store, sessions } = setup()
  await expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('owner unverifiable')
  expect(startPreparedWslDaemonOwner).toHaveBeenCalledWith(prepared, expect.any(AbortSignal))
  expect(lease).toHaveBeenCalledOnce()
  expect(store.upsertWslDaemonRecovery).not.toHaveBeenCalled()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  expect(detach).toHaveBeenCalledOnce()
  await sessions.dispose()
})

it('isolates caller cancellation from another waiter and the durable connection', async () => {
  const { store, sessions } = setup()
  const persisted = deferred<void>()
  store.upsertWslDaemonRecovery.mockReturnValue(persisted.promise)
  const abort = new AbortController()
  const canceled = sessions.prepareFresh('Ubuntu', abort.signal)
  const survivor = sessions.prepareFresh('Ubuntu')
  abort.abort(new Error('cancel only this spawn'))
  await expect(canceled).rejects.toThrow('cancel only this spawn')
  persisted.resolve()
  await survivor
  expect(detach).not.toHaveBeenCalled()
  await sessions.dispose()
})

it('fences publication after profile disposal during a durable write', async () => {
  const { store, sessions } = setup()
  const persisted = deferred<void>()
  store.upsertWslDaemonRecovery.mockReturnValue(persisted.promise)
  const opening = sessions.prepareFresh('Ubuntu')
  const rejected = expect(opening).rejects.toThrow('disposed')
  await vi.waitFor(() => expect(store.upsertWslDaemonRecovery).toHaveBeenCalledOnce())
  const closing = sessions.dispose()
  persisted.resolve()
  await Promise.all([rejected, closing])
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  expect(detach).toHaveBeenCalledOnce()
})

it('unregisters immediately and awaits detach checkpoint completion', async () => {
  const { sessions } = setup()
  await sessions.prepareFresh('Ubuntu')
  const checkpoint = deferred<void>()
  detach.mockReturnValue(checkpoint.promise)
  let completed = false
  const closing = sessions.dispose().then(() => {
    completed = true
  })
  expect(unregister).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(completed).toBe(false)
  checkpoint.resolve()
  await closing
  expect(completed).toBe(true)
})

it('does not execute guest probes after a distro replacement', async () => {
  vi.mocked(readWslDistributionIdentity).mockResolvedValue('replacement')
  const { sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  await expect(sessions.reconnect(owner)).rejects.toThrow('unverifiable')
  expect(run).not.toHaveBeenCalled()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  await sessions.dispose()
})

it('refuses unknown persisted owners instead of capturing the current default user', async () => {
  const { sessions } = setup()
  await expect(sessions.reconnect(owner)).rejects.toThrow('unverifiable')
  expect(prepareWslDaemonEndpoint).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
  await sessions.dispose()
})

it('does not start or republish an unreachable persisted daemon', async () => {
  const { sessions, store } = setup({ kind: 'daemon', ...owner, endpoint })
  lease.mockRejectedValueOnce(new Error('owner contact unverifiable'))
  await expect(sessions.reconnect(owner)).rejects.toThrow('unverifiable')
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  expect(store.upsertWslDaemonRecovery).not.toHaveBeenCalled()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  expect(detach).toHaveBeenCalledOnce()
  await sessions.dispose()
})

it('does not publish delayed preparation after the profile has closed', async () => {
  const preparation = deferred<typeof prepared>()
  vi.mocked(prepareWslDaemonEndpoint).mockReturnValue(preparation.promise)
  const { sessions } = setup()
  const opening = sessions.prepareFresh('Ubuntu')
  const rejected = expect(opening).rejects.toThrow('disposed')
  const closing = sessions.dispose()
  preparation.resolve(prepared)
  await Promise.all([rejected, closing])
  expect(DaemonPtyAdapter).not.toHaveBeenCalled()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
})

it('refuses a changed endpoint under an already-published owner identity', async () => {
  const { sessions } = setup()
  await sessions.prepareFresh('Ubuntu')
  vi.mocked(prepareWslDaemonEndpoint).mockResolvedValue({
    ...prepared,
    endpoint: { ...endpoint, userName: 'bob' }
  })
  await expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('cannot change')
  expect(DaemonPtyAdapter).toHaveBeenCalledOnce()
  expect(registerWslPtyProvider).toHaveBeenCalledOnce()
  await sessions.dispose()
})

it('reconnects a parsed terminal identity without persisting its session suffix', async () => {
  const { store, sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  const parsed = parseAppWslPtyId(toAppWslPtyId(owner, 'persisted-session'))
  if (!parsed) {
    throw new Error('Invalid fixture terminal identity')
  }
  try {
    const connection = await sessions.reconnect(parsed)
    expect(connection.owner).toEqual(owner)
    expect(store.upsertWslDaemonRecovery).toHaveBeenCalledWith(
      {
        kind: 'daemon',
        ...owner,
        endpoint
      },
      null
    )
    expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  } finally {
    await sessions.dispose()
  }
})

it('refuses a missing identity-less owner even for a fresh spawn', async () => {
  const { sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  await sessions.prepareFresh('Ubuntu')
  lease.mockRejectedValueOnce(new Error('owner contact unverifiable'))
  await expect(sessions.reconnect(owner)).rejects.toThrow('unverifiable')
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  lease.mockRejectedValueOnce(new Error('missing endpoint'))
  await expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('unverifiable')
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  expect(DaemonPtyAdapter).toHaveBeenCalledOnce()
  await sessions.dispose()
})

it('retains a cached owner when fresh startup cannot prove its endpoint absent', async () => {
  const { sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  await sessions.prepareFresh('Ubuntu')
  lease.mockRejectedValueOnce(new Error('contact failed'))
  vi.mocked(startPreparedWslDaemonOwner).mockRejectedValueOnce(new Error('owner unverifiable'))
  await expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('unverifiable')
  expect(detach).not.toHaveBeenCalled()
  expect(unregister).not.toHaveBeenCalled()
  await sessions.reconnect(owner)
  expect(DaemonPtyAdapter).toHaveBeenCalledOnce()
  await sessions.dispose()
})

it('does not bypass missing identity proof when fresh spawn joins failed reconnect', async () => {
  const { sessions } = setup({ kind: 'daemon', ...owner, endpoint })
  let fail!: (error: Error) => void
  lease.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        fail = reject
      })
  )
  const restore = sessions.reconnect(owner)
  const rejected = expect(restore).rejects.toThrow('unverifiable')
  await vi.waitFor(() => expect(lease).toHaveBeenCalledOnce())
  const fresh = expect(sessions.prepareFresh('Ubuntu')).rejects.toThrow('unverifiable')
  await vi.waitFor(() => expect(prepareWslDaemonEndpoint).toHaveBeenCalledOnce())
  await Promise.resolve()
  lease.mockRejectedValueOnce(new Error('missing endpoint'))
  fail(new Error('missing endpoint'))
  await rejected
  await fresh
  expect(startPreparedWslDaemonOwner).not.toHaveBeenCalled()
  expect(registerWslPtyProvider).not.toHaveBeenCalled()
  await sessions.dispose()
})
