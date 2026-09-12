import { expect, it, vi } from 'vitest'
import type { RequestContext } from './dispatcher'
import { RelayOwnerReset } from './relay-owner-reset'

function fixture(
  persistPrepared?: ConstructorParameters<typeof RelayOwnerReset>[0]['persistPrepared']
) {
  let settlement: Parameters<NonNullable<RequestContext['onResponseSettled']>>[0] | undefined
  const context: RequestContext = {
    clientId: 1,
    isStale: () => false,
    sessionIdentity: {
      authenticated: true,
      allowSessionOwner: true,
      authenticationKind: 'endpoint-credential',
      principal: 'owner'
    },
    onResponseSettled: (callback) => {
      settlement = callback
    }
  }
  const owner = { ownerGeneration: 1, ownerLease: 'lease' }
  const owners = {
    activeSessionOwner: vi.fn(() => owner as typeof owner | null),
    assertOwnerPublicationSettled: vi.fn()
  }
  const lifecycle = {
    prepareShutdown: vi.fn(async (_context?: RequestContext, admitted?: () => void) => {
      admitted?.()
    }),
    finishShutdown: vi.fn()
  }
  const ownsEndpoint = vi.fn(() => true)
  const reset = new RelayOwnerReset({ owners, lifecycle, ownsEndpoint, persistPrepared })
  const params = {
    version: 1,
    operationId: 'reset-1',
    runtimeIncarnation: reset.runtimeIncarnation,
    ...owner
  }
  return {
    context,
    owners,
    lifecycle,
    ownsEndpoint,
    reset,
    params,
    settle: (ok: boolean) =>
      settlement?.(ok ? { ok: true } : { ok: false, error: new Error('write failed') })
  }
}

it('withholds acknowledgment on journal failure and reflushes without repeating preparation', async () => {
  const persist = vi
    .fn<NonNullable<ConstructorParameters<typeof RelayOwnerReset>[0]['persistPrepared']>>()
    .mockImplementationOnce(() => {
      throw new Error('disk unavailable')
    })
    .mockReturnValue(undefined)
  const f = fixture(persist)
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('disk unavailable')
  f.settle(true)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  await expect(f.reset.prepare(f.params, f.context)).resolves.toMatchObject({ prepared: true })
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenCalledTimes(2)
  expect(persist).toHaveBeenLastCalledWith(
    f.params,
    'owner',
    'endpoint-credential',
    expect.any(Function)
  )
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledTimes(1)
})

it('prepared continuation also requires a confirmed journal reflush before acknowledgment', async () => {
  const persist = vi
    .fn<NonNullable<ConstructorParameters<typeof RelayOwnerReset>[0]['persistPrepared']>>()
    .mockReturnValue(undefined)
  const f = fixture(persist)
  await f.reset.prepare(f.params, f.context)
  f.settle(false)
  persist.mockImplementationOnce(() => {
    throw new Error('journal uncertain')
  })
  expect(() => f.reset.recoverPrepared(f.params, { ...f.context, clientId: 2 })).toThrow(
    'journal uncertain'
  )
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  expect(f.reset.recoverPrepared(f.params, { ...f.context, clientId: 3 })).toMatchObject({
    prepared: true
  })
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(1)
  expect(persist).toHaveBeenCalledTimes(3)
})

it('rejects an asynchronous journal hook rather than acknowledging before durability', async () => {
  const write = vi.fn(() => Promise.resolve())
  const f = fixture(
    write as unknown as NonNullable<
      ConstructorParameters<typeof RelayOwnerReset>[0]['persistPrepared']
    >
  )
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('not_synchronous')
  f.settle(true)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
})

it('finishes only after successful preparation and successful response settlement', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.lifecycle.prepareShutdown.mockReturnValue(pending.promise)
  const result = f.reset.prepare(f.params, f.context)
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledWith(f.context, expect.any(Function))
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  pending.resolve()
  await expect(result).resolves.toEqual({
    version: 1,
    operationId: 'reset-1',
    runtimeIncarnation: f.reset.runtimeIncarnation,
    prepared: true
  })
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  f.settle(true)
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledOnce()
})

it.each(['unauthenticated', 'subscriber', 'stale', 'endpoint', 'lease', 'callback'])(
  'refuses %s admission before destructive preparation',
  async (failure) => {
    const f = fixture()
    if (failure === 'unauthenticated') {
      f.context.sessionIdentity!.authenticated = false
    }
    if (failure === 'subscriber') {
      f.owners.activeSessionOwner.mockReturnValue(null)
    }
    if (failure === 'stale') {
      f.context.isStale = () => true
    }
    if (failure === 'endpoint') {
      f.ownsEndpoint.mockReturnValue(false)
    }
    if (failure === 'lease') {
      f.params.ownerLease = 'another'
    }
    if (failure === 'callback') {
      f.context.onResponseSettled = () => {
        throw new Error('registration failed')
      }
    }
    await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow()
    expect(f.lifecycle.prepareShutdown).not.toHaveBeenCalled()
  }
)

it('does not finish on failed preparation even when its error response is written', async () => {
  const f = fixture()
  f.lifecycle.prepareShutdown.mockRejectedValue(new Error('transfer fenced'))
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('transfer fenced')
  f.settle(true)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
})

it('does not infer successful reset from a lost response', async () => {
  const f = fixture()
  await f.reset.prepare(f.params, f.context)
  f.settle(false)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
})

it('recovers only a retained prepared result on a fresh authenticated transport without ownership admission', async () => {
  const f = fixture()
  await f.reset.prepare(f.params, f.context)
  f.settle(false)
  f.owners.activeSessionOwner.mockReturnValue(null)
  const context = { ...f.context, clientId: 2, transportGeneration: 2 }
  expect(f.reset.recoverPrepared(f.params, context)).toMatchObject({ prepared: true })
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledOnce()
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledOnce()
})

it.each(['missing', 'pending', 'failed'])(
  'refuses %s preparation without invoking cleanup from recovery',
  async (state) => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    let initial: Promise<unknown> | undefined
    if (state === 'pending') {
      f.lifecycle.prepareShutdown.mockReturnValue(pending.promise)
      initial = f.reset.prepare(f.params, f.context)
    } else if (state === 'failed') {
      f.lifecycle.prepareShutdown.mockImplementationOnce(async (_context, admitted) => {
        admitted?.()
        throw new Error('failed')
      })
      await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('failed')
    }
    const calls = f.lifecycle.prepareShutdown.mock.calls.length
    expect(() => f.reset.recoverPrepared(f.params, { ...f.context, clientId: 2 })).toThrow(
      'relay_reset_continuation_unauthorized'
    )
    expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(calls)
    pending.resolve()
    await initial
  }
)

it.each(['incarnation', 'lease', 'principal', 'endpoint', 'unauthenticated'])(
  'rejects changed %s in reconnect continuation',
  async (changed) => {
    const f = fixture()
    await f.reset.prepare(f.params, f.context)
    const params = { ...f.params }
    if (changed === 'incarnation') {
      params.runtimeIncarnation = 'old-process'
    }
    if (changed === 'lease') {
      params.ownerLease = 'wrong'
    }
    if (changed === 'principal') {
      f.context.sessionIdentity!.principal = 'other'
    }
    if (changed === 'endpoint') {
      f.ownsEndpoint.mockReturnValue(false)
    }
    if (changed === 'unauthenticated') {
      f.context.sessionIdentity!.authenticated = false
    }
    expect(() => f.reset.recoverPrepared(params, { ...f.context, clientId: 2 })).toThrow(
      'relay_reset_continuation_unauthorized'
    )
    expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  }
)

it('rechecks the recovery transport at response settlement and preserves later recovery', async () => {
  const f = fixture()
  await f.reset.prepare(f.params, f.context)
  let stale = false
  f.reset.recoverPrepared(f.params, { ...f.context, clientId: 2, isStale: () => stale })
  stale = true
  expect(() => f.settle(true)).toThrow('relay_reset_continuation_unauthorized')
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  f.reset.recoverPrepared(f.params, { ...f.context, clientId: 3 })
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledOnce()
})

it('replays a prepared same-transport retry without repeating destructive cleanup', async () => {
  const f = fixture()
  await f.reset.prepare(f.params, f.context)
  f.settle(false)
  await expect(f.reset.prepare(f.params, { ...f.context })).resolves.toMatchObject({
    prepared: true
  })
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledOnce()
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledOnce()
})

it('refuses pending duplicates without waiting on the first request', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.lifecycle.prepareShutdown.mockReturnValue(pending.promise)
  const first = f.reset.prepare(f.params, f.context)
  await expect(f.reset.prepare(f.params, { ...f.context })).rejects.toThrow(
    'relay_reset_preparation_in_progress'
  )
  pending.resolve()
  await first
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledOnce()
})

it.each(['operation', 'transport', 'principal'])(
  'refuses changed %s on prepared replay',
  async (changed) => {
    const f = fixture()
    await f.reset.prepare(f.params, f.context)
    f.settle(false)
    if (changed === 'operation') {
      f.params.operationId = 'different'
    } else if (changed === 'transport') {
      f.context.transportGeneration = 2
    } else {
      f.context.sessionIdentity!.principal = 'different'
    }
    await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow(
      'relay_reset_operation_conflict'
    )
    expect(f.lifecycle.prepareShutdown).toHaveBeenCalledOnce()
    expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  }
)

it('retries failed cleanup explicitly instead of replaying it as prepared', async () => {
  const f = fixture()
  f.lifecycle.prepareShutdown.mockRejectedValueOnce(new Error('cleanup failed'))
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('cleanup failed')
  await f.reset.prepare(f.params, { ...f.context })
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledTimes(2)
})

it('releases an operation refused before admission so a new operation can proceed', async () => {
  const f = fixture()
  f.lifecycle.prepareShutdown.mockRejectedValueOnce(new Error('transfer fenced'))
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('transfer fenced')
  f.params.operationId = 'new-reset'
  await expect(f.reset.prepare(f.params, f.context)).resolves.toMatchObject({
    operationId: 'new-reset'
  })
})

it('retains an admitted operation through cleanup failure and a later pre-admission refusal', async () => {
  const f = fixture()
  f.lifecycle.prepareShutdown.mockImplementationOnce(async (_context, admitted) => {
    admitted?.()
    throw new Error('cleanup failed')
  })
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('cleanup failed')
  f.lifecycle.prepareShutdown.mockRejectedValueOnce(new Error('early retry refusal'))
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow('early retry refusal')
  await expect(
    f.reset.prepare({ ...f.params, operationId: 'different' }, f.context)
  ).rejects.toThrow('relay_reset_operation_conflict')
  await f.reset.prepare(f.params, f.context)
})

it('allows an explicit prepared replay to retry final shutdown after it throws', async () => {
  const f = fixture()
  f.lifecycle.finishShutdown.mockImplementationOnce(() => {
    throw new Error('finish failed')
  })
  await f.reset.prepare(f.params, f.context)
  expect(() => f.settle(true)).toThrow('finish failed')
  await f.reset.prepare(f.params, { ...f.context })
  f.settle(true)
  expect(f.lifecycle.finishShutdown).toHaveBeenCalledTimes(2)
  expect(f.lifecycle.prepareShutdown).toHaveBeenCalledOnce()
})

it('refuses a queued replacement grant before starting shutdown', async () => {
  const f = fixture()
  f.owners.assertOwnerPublicationSettled.mockImplementation(() => {
    throw new Error('pty_consumer_owner_publication_pending')
  })
  await expect(f.reset.prepare(f.params, f.context)).rejects.toThrow(
    'pty_consumer_owner_publication_pending'
  )
  expect(f.lifecycle.prepareShutdown).not.toHaveBeenCalled()
  f.settle(true)
  expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
})

it.each(['owner', 'endpoint'])(
  'refuses completion if %s changes during preparation',
  async (changed) => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    f.lifecycle.prepareShutdown.mockReturnValue(pending.promise)
    const result = f.reset.prepare(f.params, f.context)
    if (changed === 'owner') {
      f.owners.activeSessionOwner.mockReturnValue(null)
    } else {
      f.ownsEndpoint.mockReturnValue(false)
    }
    pending.resolve()
    await expect(result).rejects.toThrow('relay_reset_unauthorized')
    f.settle(true)
    expect(f.lifecycle.finishShutdown).not.toHaveBeenCalled()
  }
)
