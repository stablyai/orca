import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnectionCallbacks } from './ssh-connection'

const state = vi.hoisted(() => ({
  admission: vi.fn(),
  opening: undefined as Promise<void> | undefined,
  instances: [] as {
    callbacks: SshConnectionCallbacks
    disconnect: ReturnType<typeof vi.fn>
    disconnectAndDrain: ReturnType<typeof vi.fn>
    setCallbacks: ReturnType<typeof vi.fn>
  }[]
}))
vi.mock('./profile-lifetime-admission', () => ({ assertProfileLifetimeAdmission: state.admission }))
vi.mock('./ssh-connection', () => ({
  SshConnection: class {
    subscribeTransportClosure = vi.fn(() => () => {})
    disconnect = vi.fn(async () => {})
    disconnectAndDrain = vi.fn(async () => this.disconnect())
    setCallbacks = vi.fn()
    constructor(
      _target: SshTarget,
      public callbacks: SshConnectionCallbacks
    ) {
      state.instances.push(this)
    }
    async connect(): Promise<void> {
      await state.opening
    }
    getState(): { status: string } {
      return { status: 'connected' }
    }
  }
}))
import { SshConnectionManager } from './ssh-connection-manager'

const target = { id: 'one', label: 'One', host: 'example.test', port: 22 } as SshTarget
const options = () => ({
  signal: new AbortController().signal,
  assertAuthority: vi.fn<() => void>()
})
beforeEach(() => {
  state.instances.length = 0
  state.opening = undefined
  state.admission.mockReset()
})

describe('exclusive SSH connections', () => {
  it('drains rejected startup even after its abort interruption fails', async () => {
    const opening = Promise.withResolvers<void>()
    state.opening = opening.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const controller = new AbortController()
    const pending = manager.connectExclusive(target, { ...options(), signal: controller.signal })
    const interrupted = new Error('interrupt_failed')
    const failed = new Error('connect_failed')
    state.instances[0].disconnect.mockRejectedValueOnce(interrupted)
    controller.abort()
    const drained = Promise.withResolvers<void>()
    state.instances[0].disconnectAndDrain.mockReturnValueOnce(drained.promise)
    opening.reject(failed)
    await vi.waitFor(() => expect(state.instances[0].disconnectAndDrain).toHaveBeenCalledOnce())
    await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
    const drainSignal = state.instances[0].disconnectAndDrain.mock.calls[0][0] as AbortSignal
    expect(drainSignal.aborted).toBe(false)
    drained.resolve()
    await expect(pending).rejects.toMatchObject({ errors: [failed, interrupted] })
    expect(manager.hasTargetActivity(target.id)).toBe(true)
  })

  it('retains target reservation until owned physical transport drain completes', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const lease = await manager.connectExclusive(target, options())
    const drained = Promise.withResolvers<void>()
    state.instances[0].disconnectAndDrain.mockReturnValue(drained.promise)
    let released = false
    const pending = lease.release().then(() => {
      released = true
    })
    await Promise.resolve()
    expect(released).toBe(false)
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    expect(manager.getConnection(target.id)).toBe(lease.connection)
    await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
    drained.resolve()
    await pending
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })
  it('pins target identity across opening and releases only that reservation', async () => {
    const opening = Promise.withResolvers<void>()
    state.opening = opening.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const mutableTarget = { ...target }
    const pending = manager.connectExclusive(mutableTarget, options())
    mutableTarget.id = 'other'
    opening.resolve()
    const lease = await pending
    state.opening = undefined
    const other = await manager.connect(mutableTarget)
    expect(manager.getConnection(target.id)).toBe(lease.connection)
    await lease.release()
    expect(manager.getConnection(target.id)).toBeUndefined()
    expect(manager.getConnection('other')).toBe(other)
  })

  it('reserves a raw connection without publishing ordinary state or replacing its callbacks', async () => {
    const callbacks = { onStateChange: vi.fn() }
    const manager = new SshConnectionManager(callbacks)
    const lease = await manager.connectExclusive(target, options())
    state.instances[0].callbacks.onStateChange(target.id, lease.connection.getState())
    expect(callbacks.onStateChange).not.toHaveBeenCalled()
    manager.setCallbacks({ onStateChange: vi.fn() })
    expect(state.instances[0].setCallbacks).not.toHaveBeenCalled()
    await expect(manager.connect(target)).rejects.toThrow('ssh_target_exclusively_owned')
    await expect(manager.reconnect(target.id)).rejects.toThrow('ssh_target_exclusively_owned')
    await expect(manager.connectExclusive(target, options())).rejects.toThrow(
      'ssh_target_has_activity'
    )
    await lease.release()
    await lease.release()
    expect(state.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })

  it.each(['native', 'caller', 'abort'])('refuses %s authority before allocating', async (kind) => {
    const opts = options()
    if (kind === 'native') {
      state.admission.mockImplementation(() => {
        throw new Error('refused')
      })
    }
    if (kind === 'caller') {
      opts.assertAuthority.mockImplementation(() => {
        throw new Error('refused')
      })
    }
    if (kind === 'abort') {
      opts.signal = AbortSignal.abort()
    }
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await expect(manager.connectExclusive(target, opts)).rejects.toThrow()
    expect(state.instances).toHaveLength(0)
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })

  it('refuses existing ordinary connections without closing them', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    await manager.connect(target)
    await expect(manager.connectExclusive(target, options())).rejects.toThrow(
      'ssh_target_has_activity'
    )
    expect(state.instances).toHaveLength(1)
    expect(state.instances[0].disconnect).not.toHaveBeenCalled()
  })

  it('checks authority after connect and closes the exact failed attempt', async () => {
    const gate = Promise.withResolvers<void>()
    state.opening = gate.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const opts = options()
    const pending = manager.connectExclusive(target, opts)
    opts.assertAuthority.mockImplementation(() => {
      throw new Error('changed')
    })
    gate.resolve()
    await expect(pending).rejects.toThrow('changed')
    expect(state.instances[0].disconnect).toHaveBeenCalledOnce()
    expect(manager.hasTargetActivity(target.id)).toBe(false)
  })

  it('accounts for aborted pending work and closes late resolution without evicting replacement', async () => {
    const gate = Promise.withResolvers<void>()
    state.opening = gate.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const controller = new AbortController()
    const pending = manager.connectExclusive(target, { ...options(), signal: controller.signal })
    controller.abort()
    await vi.waitFor(() => expect(manager.getConnection(target.id)).toBeUndefined())
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    await expect(manager.connectExclusive(target, options())).rejects.toThrow(
      'ssh_target_has_activity'
    )
    state.opening = undefined
    await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
    const replacement = await manager.connect({ ...target, id: 'replacement' })
    // Model an external registry replacement; ordinary callers cannot reuse the owned reservation.
    ;(manager as unknown as { connections: Map<string, unknown> }).connections.set(
      target.id,
      replacement
    )
    gate.resolve()
    await expect(pending).rejects.toThrow()
    expect(manager.getConnection(target.id)).toBe(replacement)
    expect(state.instances[0].disconnect).toHaveBeenCalledTimes(2)
    expect(state.instances[0].disconnectAndDrain).toHaveBeenCalledOnce()
    expect(state.instances[1].disconnect).not.toHaveBeenCalled()
  })

  it('forwards credentials only while authority is retained, including across its await', async () => {
    const credential = Promise.withResolvers<string>()
    const request = vi.fn(() => credential.promise)
    const manager = new SshConnectionManager({
      onStateChange: vi.fn(),
      onCredentialRequest: request
    })
    const opts = options()
    const lease = await manager.connectExclusive(target, opts)
    const callback = state.instances[0].callbacks.onCredentialRequest!
    const pending = callback(target.id, 'password', 'detail')
    opts.assertAuthority.mockImplementation(() => {
      throw new Error('changed')
    })
    credential.resolve('secret')
    await expect(pending).rejects.toThrow('changed')
    await expect(callback(target.id, 'password', 'detail')).rejects.toThrow('changed')
    expect(request).toHaveBeenCalledOnce()
    await lease.release()
  })

  it('keeps failed late drain observable without closing a replacement connection', async () => {
    const opening = Promise.withResolvers<void>()
    state.opening = opening.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const controller = new AbortController()
    const pending = manager.connectExclusive(target, { ...options(), signal: controller.signal })
    controller.abort()
    await vi.waitFor(() => expect(manager.getConnection(target.id)).toBeUndefined())
    state.opening = undefined
    await expect(manager.connect(target)).rejects.toThrow('exclusively_owned')
    const replacement = await manager.connect({ ...target, id: 'replacement' })
    ;(manager as unknown as { connections: Map<string, unknown> }).connections.set(
      target.id,
      replacement
    )
    state.instances[0].disconnectAndDrain.mockRejectedValueOnce(new Error('close unconfirmed'))
    opening.resolve()
    await expect(pending).rejects.toMatchObject({
      message: 'ssh_exclusive_connection_cleanup_failed',
      errors: expect.arrayContaining([expect.objectContaining({ message: 'close unconfirmed' })])
    })
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    expect(manager.getConnection(target.id)).toBe(replacement)
    expect(state.instances[1].disconnect).not.toHaveBeenCalled()
  })

  it('retains both connection and cleanup failures', async () => {
    const gate = Promise.withResolvers<void>()
    state.opening = gate.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const pending = manager.connectExclusive(target, options())
    const failure = new Error('connect_failed')
    const cleanupFailure = new Error('cleanup_failed')
    state.instances[0].disconnect.mockRejectedValueOnce(cleanupFailure)
    gate.reject(failure)
    await expect(pending).rejects.toMatchObject({
      message: 'ssh_exclusive_connection_cleanup_failed',
      errors: [failure, cleanupFailure]
    })
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    expect(state.instances[0].disconnectAndDrain).toHaveBeenCalledOnce()
  })

  it('refuses ordinary pending work after its registered connection is removed', async () => {
    const gate = Promise.withResolvers<void>()
    state.opening = gate.promise
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const pending = manager.connect(target)
    await manager.disconnect(target.id)
    await expect(manager.connectExclusive(target, options())).rejects.toThrow(
      'ssh_target_has_activity'
    )
    expect(state.instances).toHaveLength(1)
    gate.reject(new Error('canceled'))
    await expect(pending).rejects.toThrow('canceled')
  })

  it('retains failed teardown evidence and reports the same release failure', async () => {
    const manager = new SshConnectionManager({ onStateChange: vi.fn() })
    const lease = await manager.connectExclusive(target, options())
    state.instances[0].disconnect.mockRejectedValueOnce(new Error('cleanup'))
    await expect(lease.release()).rejects.toThrow('cleanup')
    await expect(lease.release()).rejects.toThrow('cleanup')
    expect(manager.hasTargetActivity(target.id)).toBe(true)
    await expect(manager.connectExclusive(target, options())).rejects.toThrow(
      'ssh_target_has_activity'
    )
  })
})
