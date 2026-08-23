import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR,
  SSH_PTY_RESTORE_REQUIRED_ERROR,
  SSH_SESSION_EXPIRED_ERROR
} from './ssh-pty-errors'
import { MAX_SSH_PTY_EXIT_TOMBSTONES } from './ssh-pty-liveness-state'
import { SshPtyProvider } from './ssh-pty-provider'

// The relay answers `restoreRequired` from its DELIVERY layer only: `requireRestore`
// (src/relay/relay-pty-source-publication.ts) retires the delivery record and never touches the
// managed PTY. Reporting it as expiry orphans a live remote agent and cold-starts a duplicate.

function createMockMux(): {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
} {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn().mockReturnValue(vi.fn()),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

type MockMux = ReturnType<typeof createMockMux>

function notificationHandler(
  mux: MockMux
): (method: string, params: Record<string, unknown>) => void {
  const handler = mux.onNotification.mock.calls[0]?.[0]
  if (typeof handler !== 'function') {
    throw new Error('expected notification handler')
  }
  return handler
}

const restoreRequiredAnswer = {
  incarnationId: 'incarnation-reattached',
  sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
}

const firstActivation = {
  status: 'pending',
  clientGeneration: 2,
  ownerGeneration: 3,
  ptyIncarnation: 'incarnation-reattached',
  deliveryToken: 'token-first',
  checkpointSourceEndSu: 0,
  recoveryEndSu: 0
}

const secondActivation = {
  ...firstActivation,
  clientGeneration: 4,
  ownerGeneration: 5,
  deliveryToken: 'token-second'
}

async function spawnError(provider: SshPtyProvider): Promise<string> {
  try {
    await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected spawn to reject')
}

describe('SSH PTY reattach when the relay requires source restoration', () => {
  it('keeps an unprobed PTY unverifiable', async () => {
    const provider = new SshPtyProvider('conn-1', createMockMux() as never)

    expect(provider.hasPty('ssh:conn-1@@pty-unprobed')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-unprobed')).resolves.toBeNull()
  })

  it('reports unverifiable when the initial attach loses contact', async () => {
    const mux = createMockMux()
    mux.request.mockRejectedValueOnce(new Error('Multiplexer disposed'))
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    expect(message).toContain(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
    expect(message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBeNull()
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(1)
  })

  it('keeps a reconnecting PTY unverifiable after an authoritative empty inventory', async () => {
    const id = 'ssh:conn-1@@pty-reconnecting'
    const mux = createMockMux()
    mux.request.mockResolvedValueOnce([])
    const provider = new SshPtyProvider('conn-1', mux as never)

    await provider.listProcesses()

    expect(provider.hasPty(id)).toBe(false)
    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
  })

  it('does not classify an exit before the owner validates its incarnation', async () => {
    const id = 'ssh:conn-1@@pty-live'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.acceptLivePty(id)

    notificationHandler(mux)('pty.exit', {
      id: 'pty-live',
      code: 0,
      incarnationId: 'stale-incarnation'
    })

    await expect(provider.probePtyLiveness(id)).resolves.toBe(true)
  })

  it('does not revive an exited PTY from unvalidated data or replay', async () => {
    const id = 'ssh:conn-1@@pty-exited'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onData(() => {})
    provider.onReplay(() => {})
    provider.acceptExitedPty(id)

    notificationHandler(mux)('pty.data', { id: 'pty-exited', data: 'stale' })
    notificationHandler(mux)('pty.replay', { id: 'pty-exited', data: 'stale replay' })

    await expect(provider.probePtyLiveness(id)).resolves.toBe(false)
  })

  it('keeps exact exited evidence after a later ambiguous exit', async () => {
    const id = 'ssh:conn-1@@pty-exited'
    const provider = new SshPtyProvider('conn-1', createMockMux() as never)
    provider.acceptExitedPty(id)

    provider.acceptUnverifiablePty(id)

    await expect(provider.probePtyLiveness(id)).resolves.toBe(false)
  })

  it('does not retain a synthetic incarnation from a legacy exit', () => {
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    const exitIncarnations: string[] = []
    const dataIncarnations: string[] = []
    provider.onExit((payload) => exitIncarnations.push(payload.ptyIncarnation))
    provider.onData((payload) => dataIncarnations.push(payload.ptyIncarnation))

    notificationHandler(mux)('pty.exit', { id: 'pty-legacy', code: 0 })
    notificationHandler(mux)('pty.data', { id: 'pty-legacy', data: 'still-live' })

    expect(exitIncarnations).toHaveLength(1)
    expect(dataIncarnations).toHaveLength(1)
    expect(dataIncarnations[0]).not.toBe(exitIncarnations[0])
  })

  it('bounds exited PTY evidence and evicts to unverifiable', async () => {
    const provider = new SshPtyProvider('conn-1', createMockMux() as never)
    for (let index = 0; index <= MAX_SSH_PTY_EXIT_TOMBSTONES; index += 1) {
      provider.acceptExitedPty(`pty-${index}`)
    }

    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-0')).resolves.toBeNull()
    await expect(
      provider.probePtyLiveness(`ssh:conn-1@@pty-${MAX_SSH_PTY_EXIT_TOMBSTONES}`)
    ).resolves.toBe(false)
  })

  it('leaves an unattributable exit unverifiable without disturbing the other panes', async () => {
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.acceptLivePty('ssh:conn-1@@pty-live')
    provider.acceptLivePty('ssh:conn-1@@pty-ambiguous')

    provider.acceptAmbiguousExitPty('pty-ambiguous')

    // Why not `false`: no host attributed this exit to the pane, so it is not evidence of death.
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-ambiguous')).resolves.toBeNull()
    expect(mux.dispose).not.toHaveBeenCalled()
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-live')).resolves.toBe(true)
  })

  it('keeps reconnect liveness unverifiable until relay activation', async () => {
    const id = 'ssh:conn-1@@pty-reconnecting'
    const mux = createMockMux()
    mux.request.mockResolvedValue({ incarnationId: 'incarnation-reconnect' })
    const provider = new SshPtyProvider('conn-1', mux as never)

    await provider.attachForReconnect(id)

    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
    provider.acceptLivePty(id)
    await expect(provider.probePtyLiveness(id)).resolves.toBe(true)
  })

  it('does not promote an attach response after a newer legacy exit', async () => {
    const id = 'ssh:conn-1@@pty-attach'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptUnverifiablePty(payload.id))
    mux.request.mockImplementation(async (method: string, _params, options) => {
      if (method !== 'pty.attach') {
        return undefined
      }
      const result = { incarnationId: 'incarnation-attach' }
      options?.beforeResolve?.(result)
      notificationHandler(mux)('pty.exit', { id: 'pty-attach', code: 0 })
      return result
    })

    await provider.attach(id)

    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
  })

  it('does not promote an inventory response after a newer legacy exit', async () => {
    const id = 'ssh:conn-1@@pty-inventory'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptUnverifiablePty(payload.id))
    mux.request.mockImplementation(async (method: string, _params, options) => {
      if (method !== 'pty.listProcesses') {
        return undefined
      }
      const result = [
        {
          id: 'pty-inventory',
          cwd: '/work',
          title: 'shell',
          incarnationId: 'incarnation-inventory'
        }
      ]
      options?.beforeResolve?.(result)
      notificationHandler(mux)('pty.exit', { id: 'pty-inventory', code: 0 })
      return result
    })

    await provider.listProcesses()

    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
  })

  it('does not promote an attach response after an in-flight exact exit', async () => {
    const id = 'ssh:conn-1@@pty-attach-exited'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptExitedPty(payload.id))
    mux.request.mockImplementation(async (method: string, _params, options) => {
      if (method !== 'pty.attach') {
        return undefined
      }
      notificationHandler(mux)('pty.exit', {
        id: 'pty-attach-exited',
        code: 0,
        incarnationId: 'incarnation-attach-exited'
      })
      const result = { incarnationId: 'incarnation-attach-exited' }
      options?.beforeResolve?.(result)
      return result
    })

    await provider.attach(id)

    await expect(provider.probePtyLiveness(id)).resolves.toBe(false)
  })

  it('does not promote an inventory response after an in-flight legacy exit', async () => {
    const id = 'ssh:conn-1@@pty-inventory-unverifiable'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    // An exit with no incarnation is ambiguous exit evidence, not loss of contact.
    provider.onExit((payload) => provider.acceptAmbiguousExitPty(payload.id))
    mux.request.mockImplementation(async (method: string, _params, options) => {
      if (method !== 'pty.listProcesses') {
        return undefined
      }
      notificationHandler(mux)('pty.exit', { id: 'pty-inventory-unverifiable', code: 0 })
      const result = [
        {
          id: 'pty-inventory-unverifiable',
          cwd: '/work',
          title: 'shell',
          incarnationId: 'incarnation-inventory-unverifiable'
        }
      ]
      options?.beforeResolve?.(result)
      return result
    })

    await provider.listProcesses()

    await expect(provider.probePtyLiveness(id)).resolves.toBeNull()
  })

  it('lets a later inventory prove liveness after a concurrent loss of contact', async () => {
    const id = 'ssh:conn-1@@pty-recovered'
    const mux = createMockMux()
    const provider = new SshPtyProvider('conn-1', mux as never)
    mux.request.mockImplementation(async (method: string, _params, options) => {
      if (method !== 'pty.listProcesses') {
        return undefined
      }
      // A sibling operation loses contact while this request is in flight; that is not death.
      provider.acceptUnverifiablePty(id)
      const result = [
        {
          id: 'pty-recovered',
          cwd: '/work',
          title: 'shell',
          incarnationId: 'incarnation-recovered'
        }
      ]
      options?.beforeResolve?.(result)
      return result
    })

    await provider.listProcesses()

    await expect(provider.probePtyLiveness(id)).resolves.toBe(true)
  })

  it('re-attaches over the live PTY instead of reporting exited', async () => {
    const mux = createMockMux()
    // Why: the relay retires the stale delivery record as the restoreRequired response settles,
    // so the immediate re-attach opens a fresh delivery over the same live PTY.
    mux.request
      .mockResolvedValueOnce(restoreRequiredAnswer)
      .mockResolvedValueOnce({ incarnationId: 'incarnation-reattached', replay: 'buffered-output' })
    const provider = new SshPtyProvider('conn-1', mux as never)

    const result = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })

    expect(result).toEqual({
      id: 'ssh:conn-1@@pty-old',
      isReattach: true,
      replay: 'buffered-output',
      incarnationId: 'incarnation-reattached'
    })
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(2)
  })

  it('keeps the PTY live when the first activation cancellation is unproven', async () => {
    const mux = createMockMux()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.cancelDelivery') {
        return { canceled: false, sentEndSu: 0, creditedEndSu: 0 }
      }
      if (method === 'pty.attach') {
        const attachCount = mux.request.mock.calls.filter((call) => call[0] === method).length
        if (attachCount === 1) {
          return { ...restoreRequiredAnswer, sourceActivation: firstActivation }
        }
        return { incarnationId: 'incarnation-reattached', sourceActivation: secondActivation }
      }
      return undefined
    })
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    // The attach answered with an incarnation, so the PTY is proven live; only the retry is blocked.
    expect(message).toContain(SSH_PTY_RESTORE_REQUIRED_ERROR)
    expect(message).not.toContain(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
    expect(message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(true)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(true)
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(1)
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.spawn')).toHaveLength(0)
    expect(mux.request).toHaveBeenCalledWith('pty.cancelDelivery', {
      id: 'pty-old',
      clientGeneration: 2,
      ownerGeneration: 3,
      deliveryToken: 'token-first'
    })
  })

  it('keeps a host exit authoritative when it lands during the unproven cancellation', async () => {
    const mux = createMockMux()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.cancelDelivery') {
        // The owning host reports the process dead while the cancel round trip is in flight.
        notificationHandler(mux)('pty.exit', {
          id: 'pty-old',
          code: 0,
          incarnationId: 'incarnation-reattached'
        })
        return { canceled: false, sentEndSu: 0, creditedEndSu: 0 }
      }
      if (method === 'pty.attach') {
        return { ...restoreRequiredAnswer, sourceActivation: firstActivation }
      }
      return undefined
    })
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptExitedPty(payload.id))

    const message = await spawnError(provider)

    expect(message).toContain(SSH_PTY_RESTORE_REQUIRED_ERROR)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(false)
  })

  it('keeps a host exit authoritative when it lands during a proven cancellation', async () => {
    const mux = createMockMux()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.cancelDelivery') {
        // The owning host reports the process dead while the cancel round trip is in flight.
        notificationHandler(mux)('pty.exit', {
          id: 'pty-old',
          code: 0,
          incarnationId: 'incarnation-reattached'
        })
        return { canceled: true, sentEndSu: 0, creditedEndSu: 0 }
      }
      if (method === 'pty.attach') {
        const attachCount = mux.request.mock.calls.filter((call) => call[0] === method).length
        if (attachCount === 1) {
          return { ...restoreRequiredAnswer, sourceActivation: firstActivation }
        }
        return { incarnationId: 'incarnation-reattached', replay: 'buffered-output' }
      }
      return undefined
    })
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptExitedPty(payload.id))

    await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })

    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(2)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(false)
  })

  it('keeps a host exit authoritative when the retried attach still requires restoration', async () => {
    const mux = createMockMux()
    mux.request.mockImplementation(async (method: string) => {
      if (method === 'pty.cancelDelivery') {
        notificationHandler(mux)('pty.exit', {
          id: 'pty-old',
          code: 0,
          incarnationId: 'incarnation-reattached'
        })
        return { canceled: true, sentEndSu: 0, creditedEndSu: 0 }
      }
      if (method === 'pty.attach') {
        const attachCount = mux.request.mock.calls.filter((call) => call[0] === method).length
        // The retry has no delivery left to cancel, so nothing after it can re-observe the exit.
        return attachCount === 1
          ? { ...restoreRequiredAnswer, sourceActivation: firstActivation }
          : restoreRequiredAnswer
      }
      return undefined
    })
    const provider = new SshPtyProvider('conn-1', mux as never)
    provider.onExit((payload) => provider.acceptExitedPty(payload.id))

    const message = await spawnError(provider)

    expect(message).toContain(SSH_PTY_RESTORE_REQUIRED_ERROR)
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(2)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(false)
  })

  it('never reports a delivery failure as session expiry when restoration keeps failing', async () => {
    const mux = createMockMux()
    mux.request.mockResolvedValue(restoreRequiredAnswer)
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    expect(message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(message).toContain(SSH_PTY_RESTORE_REQUIRED_ERROR)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(true)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(true)
  })

  it('reports unverifiable when the fresh delivery attach loses contact', async () => {
    const mux = createMockMux()
    mux.request
      .mockResolvedValueOnce(restoreRequiredAnswer)
      .mockRejectedValueOnce(new Error('Multiplexer disposed'))
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    expect(message).toContain(SSH_PTY_LIVENESS_UNVERIFIABLE_ERROR)
    expect(message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBeNull()
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(2)
  })

  it('reports exited when the fresh delivery attach authoritatively finds no PTY', async () => {
    const mux = createMockMux()
    mux.request
      .mockResolvedValueOnce(restoreRequiredAnswer)
      .mockRejectedValueOnce(new Error('PTY "pty-old" not found'))
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    expect(message).toContain(`${SSH_SESSION_EXPIRED_ERROR}: pty-old`)
    expect(provider.hasPty('ssh:conn-1@@pty-old')).toBe(false)
    await expect(provider.probePtyLiveness('ssh:conn-1@@pty-old')).resolves.toBe(false)
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(2)
  })

  it('expires the lease when the relay authoritatively reports exited', async () => {
    const mux = createMockMux()
    mux.request.mockRejectedValue(new Error('PTY "pty-old" not found'))
    const provider = new SshPtyProvider('conn-1', mux as never)

    const message = await spawnError(provider)

    expect(message).toContain(`${SSH_SESSION_EXPIRED_ERROR}: pty-old`)
    expect(mux.request.mock.calls.filter((call) => call[0] === 'pty.attach')).toHaveLength(1)
  })
})
