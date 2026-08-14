import { expect, it, vi } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

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

it('fences a mismatched attach response before installing its source activation', async () => {
  const response = {
    incarnationId: 'incarnation-other',
    sourceActivation: sourceActivation('incarnation-other')
  }
  const mux = {
    request: vi.fn(async (method: string, _params, options) => {
      if (method !== 'pty.attach') {
        return undefined
      }
      options?.beforeResolve?.(response)
      return response
    }),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
  const provider = new SshPtyProvider('conn-1', mux as never)

  await expect(
    provider.attachForReconnect('ssh:conn-1@@pty-1', undefined, 'incarnation-expected')
  ).rejects.toThrow('SSH_PTY_IDENTITY_MISMATCH')

  expect(mux.request).toHaveBeenCalledTimes(1)
})
