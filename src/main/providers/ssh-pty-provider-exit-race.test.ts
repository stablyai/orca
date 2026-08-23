import { expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'
import { SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR } from './ssh-pty-errors'

function sourceActivation(ptyIncarnation: string) {
  return {
    status: 'pending' as const,
    clientGeneration: 2,
    ownerGeneration: 3,
    ptyIncarnation,
    deliveryToken: `token:${ptyIncarnation}`,
    checkpointSourceEndSu: 0,
    recoveryEndSu: 0
  }
}

it('rejects a fresh SSH PTY whose exit shares the spawn response batch', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const dataListener = vi.fn()
  provider.onData(dataListener)
  const exitListener = vi.fn()
  provider.onExit(exitListener)
  mux.request.mockImplementation(async (method: string, _params, options) => {
    if (method === 'pty.spawn') {
      const result = {
        id: 'pty-raced',
        incarnationId: 'incarnation-raced',
        sourceActivation: sourceActivation('incarnation-raced')
      }
      options?.beforeResolve?.(result)
      const notify = mux.onNotification.mock.calls[0]?.[0]
      notify?.('pty.data', {
        id: 'pty-raced',
        data: 'data',
        ptyIncarnation: 'incarnation-raced',
        deliveryToken: 'token:incarnation-raced',
        clientGeneration: 2,
        ownerGeneration: 3,
        sourceEndSu: 4,
        sourceLengthSu: 4
      })
      notify?.('pty.exit', {
        id: 'pty-raced',
        code: 0,
        incarnationId: 'incarnation-raced'
      })
      return result
    }
    if (method === 'pty.cancelDelivery') {
      return { canceled: true, sentEndSu: 4, creditedEndSu: 0 }
    }
    return undefined
  })

  await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
    'agent_session_exited_during_start'
  )

  expect(exitListener).toHaveBeenCalledWith({
    id: 'ssh:conn-1@@pty-raced',
    code: 0,
    incarnationId: 'incarnation-raced',
    providerGeneration: expect.any(Number),
    ptyIncarnation: 'incarnation-raced'
  })
  expect(dataListener).not.toHaveBeenCalled()
  expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
    id: 'pty-raced',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token:incarnation-raced'
  })
  mux.request.mockResolvedValue({ id: 'pty-next', incarnationId: 'incarnation-next' })
  await expect(provider.spawn({ cols: 80, rows: 24 })).resolves.toMatchObject({
    id: 'ssh:conn-1@@pty-next',
    incarnationId: 'incarnation-next'
  })
})

it('keeps a fresh spawn with a legacy exit unverifiable', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const acceptAmbiguousExitPty = vi.spyOn(provider, 'acceptAmbiguousExitPty')
  const exitListener = vi.fn()
  provider.onExit(exitListener)
  mux.request.mockImplementation(async (method: string, _params, options) => {
    if (method !== 'pty.spawn') {
      return undefined
    }
    const result = { id: 'pty-raced', incarnationId: 'incarnation-current' }
    options?.beforeResolve?.(result)
    const notify = mux.onNotification.mock.calls[0]?.[0]
    notify?.('pty.exit', { id: 'pty-raced', code: 0 })
    return result
  })

  await expect(provider.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
    SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR
  )
  expect(exitListener).not.toHaveBeenCalled()
  expect(acceptAmbiguousExitPty).toHaveBeenCalledExactlyOnceWith('ssh:conn-1@@pty-raced')
  await expect(provider.probePtyLiveness('ssh:conn-1@@pty-raced')).resolves.toBeNull()
})

it('rejects an SSH reattach whose matching exit shares the attach reply batch', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  mux.request.mockImplementation(async (method: string, _params, options) => {
    if (method === 'pty.attach') {
      const result = {
        incarnationId: 'incarnation-existing',
        sourceActivation: sourceActivation('incarnation-existing')
      }
      options?.beforeResolve?.(result)
      const notify = mux.onNotification.mock.calls[0]?.[0]
      notify?.('pty.exit', {
        id: 'pty-existing',
        code: 0,
        incarnationId: 'incarnation-existing'
      })
      return result
    }
    return undefined
  })

  await expect(
    provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:conn-1@@pty-existing' })
  ).rejects.toThrow('agent_session_exited_during_start')
  expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
    id: 'pty-existing',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token:incarnation-existing'
  })

  mux.request.mockResolvedValue({ incarnationId: 'incarnation-next' })
  await expect(
    provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:conn-1@@pty-existing' })
  ).resolves.toMatchObject({
    id: 'ssh:conn-1@@pty-existing',
    incarnationId: 'incarnation-next',
    isReattach: true
  })
})

it('keeps a legacy exit unverifiable while reattach resolves its incarnation', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const acceptAmbiguousExitPty = vi.spyOn(provider, 'acceptAmbiguousExitPty')
  const exitListener = vi.fn()
  provider.onExit(exitListener)
  let resolveAttach: (() => void) | undefined
  mux.request.mockImplementation((method: string, _params, options) => {
    if (method !== 'pty.attach') {
      return Promise.resolve(undefined)
    }
    return new Promise((resolve) => {
      resolveAttach = () => {
        const result = { incarnationId: 'incarnation-current' }
        options?.beforeResolve?.(result)
        resolve(result)
      }
    })
  })

  const spawn = provider.spawn({
    cols: 80,
    rows: 24,
    sessionId: 'ssh:conn-1@@pty-existing'
  })
  await vi.waitFor(() => expect(resolveAttach).toBeTypeOf('function'))
  const notify = mux.onNotification.mock.calls[0]?.[0]
  notify?.('pty.exit', { id: 'pty-existing', code: 0 })
  expect(exitListener).not.toHaveBeenCalled()
  resolveAttach?.()

  await expect(spawn).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).not.toHaveBeenCalled()
  expect(acceptAmbiguousExitPty).toHaveBeenCalledExactlyOnceWith('ssh:conn-1@@pty-existing')
  await expect(provider.probePtyLiveness('ssh:conn-1@@pty-existing')).resolves.toBeNull()

  notify?.('pty.exit', {
    id: 'pty-existing',
    code: 7,
    incarnationId: 'incarnation-current'
  })
  expect(exitListener).toHaveBeenCalledExactlyOnceWith({
    id: 'ssh:conn-1@@pty-existing',
    code: 7,
    incarnationId: 'incarnation-current',
    providerGeneration: expect.any(Number),
    ptyIncarnation: 'incarnation-current'
  })
})

it('keeps an incarnation-less attach and exit race unverifiable', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const acceptAmbiguousExitPty = vi.spyOn(provider, 'acceptAmbiguousExitPty')
  const exitListener = vi.fn()
  provider.onExit(exitListener)
  mux.request.mockImplementation(async (method: string, _params, options) => {
    if (method !== 'pty.attach') {
      return undefined
    }
    options?.beforeResolve?.({})
    const notify = mux.onNotification.mock.calls[0]?.[0]
    notify?.('pty.exit', { id: 'pty-existing', code: 0 })
    return {}
  })

  await expect(
    provider.spawn({ cols: 80, rows: 24, sessionId: 'ssh:conn-1@@pty-existing' })
  ).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).not.toHaveBeenCalled()
  expect(acceptAmbiguousExitPty).toHaveBeenCalledExactlyOnceWith('ssh:conn-1@@pty-existing')
  await expect(provider.probePtyLiveness('ssh:conn-1@@pty-existing')).resolves.toBeNull()
})

it('returns a provisional source activation lease to reconnect authority', async () => {
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)
  const response = {
    incarnationId: 'incarnation-reconnect',
    sourceActivation: {
      ...sourceActivation('incarnation-reconnect'),
      deliveryToken: 'token-reconnect',
      checkpointSourceEndSu: 4,
      recoveryEndSu: 8
    }
  }
  mux.request.mockImplementation(async (method: string, _params, options) => {
    if (method === 'pty.cancelDelivery') {
      return { canceled: true, sentEndSu: 8, creditedEndSu: 4 }
    }
    if (method !== 'pty.attach') {
      return undefined
    }
    options?.beforeResolve?.(response)
    return response
  })

  const result = await provider.attachForReconnect('ssh:conn-1@@pty-1')
  await result.sourceActivationLease?.rollback()

  expect(Object.isFrozen(result.sourceActivation)).toBe(true)
  expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
    id: 'pty-1',
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token-reconnect'
  })
})

function createDeferredAttachMux(): {
  mux: {
    request: ReturnType<typeof vi.fn>
    notify: ReturnType<typeof vi.fn>
    onNotification: ReturnType<typeof vi.fn>
    dispose: ReturnType<typeof vi.fn>
    isDisposed: ReturnType<typeof vi.fn>
  }
  attaches: { resolve: (value: unknown) => void; reject: (error: Error) => void }[]
} {
  const attaches: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
  const mux = {
    request: vi.fn(),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  mux.request.mockImplementation((method: string, _params, options) => {
    if (method !== 'pty.attach') {
      return Promise.resolve(undefined)
    }
    return new Promise((resolve, reject) => {
      attaches.push({
        resolve: (value) => {
          options?.beforeResolve?.(value)
          resolve(value)
        },
        reject
      })
    })
  })
  return { mux, attaches }
}

function notifyExit(
  mux: { onNotification: ReturnType<typeof vi.fn> },
  params: Record<string, unknown>
): void {
  const notify = mux.onNotification.mock.calls[0]?.[0] as
    | ((method: string, params: Record<string, unknown>) => void)
    | undefined
  notify?.('pty.exit', params)
}

it('delivers a host exit that a failed reattach quarantined', async () => {
  const { mux, attaches } = createDeferredAttachMux()
  const provider = new SshPtyProvider('conn-1', mux as never)
  const exitListener = vi.fn()
  provider.onExit(exitListener)

  const spawn = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  await vi.waitFor(() => expect(attaches).toHaveLength(1))
  notifyExit(mux, { id: 'pty-old', code: 7, incarnationId: 'incarnation-old' })
  expect(exitListener).not.toHaveBeenCalled()
  attaches[0]?.reject(new Error('Request timed out'))

  await expect(spawn).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).toHaveBeenCalledExactlyOnceWith({
    id: 'ssh:conn-1@@pty-old',
    code: 7,
    incarnationId: 'incarnation-old',
    providerGeneration: expect.any(Number),
    ptyIncarnation: 'incarnation-old'
  })
})

it('releases a quarantined exit once, after every concurrent reattach has failed', async () => {
  const { mux, attaches } = createDeferredAttachMux()
  const provider = new SshPtyProvider('conn-1', mux as never)
  const exitListener = vi.fn()
  provider.onExit(exitListener)

  const first = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  const second = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  await vi.waitFor(() => expect(attaches).toHaveLength(2))
  notifyExit(mux, { id: 'pty-old', code: 7, incarnationId: 'incarnation-old' })

  attaches[0]?.reject(new Error('Request timed out'))
  await expect(first).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).not.toHaveBeenCalled()

  attaches[1]?.reject(new Error('Request timed out'))
  await expect(second).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).toHaveBeenCalledOnce()
  expect(exitListener).toHaveBeenCalledWith(expect.objectContaining({ code: 7 }))
})

it('keeps a concurrent reattach the owner of a quarantined exit it fenced', async () => {
  const { mux, attaches } = createDeferredAttachMux()
  const provider = new SshPtyProvider('conn-1', mux as never)
  const exitListener = vi.fn()
  provider.onExit(exitListener)

  const first = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  const second = provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  await vi.waitFor(() => expect(attaches).toHaveLength(2))
  notifyExit(mux, { id: 'pty-old', code: 7, incarnationId: 'incarnation-old' })

  attaches[0]?.reject(new Error('Request timed out'))
  await expect(first).rejects.toThrow(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
  expect(exitListener).not.toHaveBeenCalled()

  attaches[1]?.resolve({ incarnationId: 'incarnation-new' })
  await expect(second).resolves.toMatchObject({
    id: 'ssh:conn-1@@pty-old',
    incarnationId: 'incarnation-new',
    isReattach: true
  })
  expect(exitListener).not.toHaveBeenCalled()
  await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(true)
})
