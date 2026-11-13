// GH-CREATE-CANCEL: a create cancelled in flight never leaves a sandbox running, for the owned
// create and the GitHub-only create alike (both use createSandboxWithProgress).
import { describe, expect, it, vi } from 'vitest'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { HostedEntitlementDeniedError } from './hosted-environment-provider'
import type {
  HostedSandboxDestroyResponse,
  HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { reclaimCancelledCreate, type ReclaimClient } from './hosted-sandbox-create-reclaim'
import { CANCEL_CLEANUP_UNCONFIRMED, createSandboxWithProgress } from './hosted-sandbox-driver'

const READY = {
  sandbox: {
    id: 'sbx_1',
    workspaceId: 'web-1',
    status: 'running' as const,
    machineSize: 'standard' as const,
    region: 'iad1',
    session: null,
    createdAt: 1
  },
  connection: { type: 'orca-server' as const, pairingCode: 'code', projectRoot: '/work' }
}
const BODY = { workspaceId: 'web-1', machineSize: 'standard' as const }
const quiet = { waitMs: 0, log: () => {} }

function client() {
  return {
    create: vi.fn<ReclaimClient['create']>(async () => READY),
    bootPlan: vi.fn(async () => 'clone' as const),
    cloneStatus: vi.fn(async () => ({ state: 'done' as const })),
    destroy: vi.fn(async (id: string): Promise<HostedSandboxDestroyResponse['sandbox']> => ({
      id,
      status: 'destroyed'
    })),
    list: vi.fn(async (): Promise<HostedSandboxView[]> => [])
  }
}

describe('reclaimCancelledCreate', () => {
  it('replays the create by its key and deletes the sandbox it gets back', async () => {
    const api = client()
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    expect(api.create).toHaveBeenCalledWith(BODY, undefined, 'create:k1')
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
  })

  it('waits while the first create is still in progress (409), then deletes', async () => {
    const api = client()
    api.create
      .mockRejectedValueOnce(new EnvironmentProviderError('conflict', 'idempotency_in_progress'))
      .mockRejectedValueOnce(new EnvironmentProviderError('unavailable', 'try later'))
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    expect(api.create).toHaveBeenCalledTimes(3)
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
  })

  it('a refused replay means the cancelled create made nothing either', async () => {
    const api = client()
    api.create.mockRejectedValueOnce(new HostedEntitlementDeniedError('denied', 'no_subscription'))
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    expect(api.destroy).not.toHaveBeenCalled()
  })

  it('EP-5: while the first create still runs (409), deletes the sandbox it is making by workspace id, then waits for the create to answer', async () => {
    const api = client()
    api.create
      .mockRejectedValueOnce(new EnvironmentProviderError('conflict', 'idempotency_in_progress'))
      .mockRejectedValueOnce(
        new EnvironmentProviderError('conflict', 'cancelled', 'create_cancelled')
      )
    api.list
      .mockResolvedValueOnce([
        { ...READY.sandbox, id: 'sbx_other', workspaceId: 'other-1' },
        { ...READY.sandbox, status: 'creating' }
      ])
      .mockResolvedValue([{ ...READY.sandbox, id: 'sbx_other', workspaceId: 'other-1' }])
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    expect(api.destroy).toHaveBeenCalledTimes(1)
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
    expect(api.create).toHaveBeenCalledTimes(2)
  })

  it('EP-5 (n48): a create that went on with a new row after the delete is swept too, never reported done early', async () => {
    const api = client()
    // In progress (the first row is listed and deleted); then the key answers a sandbox of its own;
    // the sweep still finds the row the create's own retry made, and deletes it.
    api.create
      .mockRejectedValueOnce(new EnvironmentProviderError('conflict', 'idempotency_in_progress'))
      .mockResolvedValueOnce({ ...READY, sandbox: { ...READY.sandbox, id: 'sbx_2' } })
    api.list
      .mockResolvedValueOnce([{ ...READY.sandbox, status: 'creating' }])
      .mockResolvedValueOnce([{ ...READY.sandbox, id: 'sbx_3', status: 'creating' }])
      .mockResolvedValue([])
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    expect(api.destroy.mock.calls.map(([id]) => id)).toEqual(['sbx_1', 'sbx_2', 'sbx_3'])
  })

  it('EP-5: a straggler that will not delete is not reported deleted', async () => {
    const api = client()
    api.list.mockResolvedValue([{ ...READY.sandbox, id: 'sbx_stuck', status: 'creating' }])
    api.destroy.mockImplementation(async (id: string) =>
      id === 'sbx_stuck' ? { id, status: 'destroying' } : { id, status: 'destroyed' }
    )
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', { ...quiet, attempts: 3 })).toBe(
      false
    )
  })

  it('EP-5: an unreadable list is not taken for an empty workspace', async () => {
    const api = client()
    api.list.mockRejectedValue(new EnvironmentProviderError('unavailable', 'down'))
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', { ...quiet, attempts: 2 })).toBe(
      false
    )
  })

  it('EP-5: a delete the control plane does not answer with destroyed is not confirmed', async () => {
    const api = client()
    api.destroy.mockImplementation(async (id: string) => ({ id, status: 'destroying' }))
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', { ...quiet, attempts: 2 })).toBe(
      false
    )
  })

  it('EP-5: 409 with nothing listed yet keeps replaying until the create answers', async () => {
    const api = client()
    api.create.mockRejectedValueOnce(
      new EnvironmentProviderError('conflict', 'idempotency_in_progress')
    )
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', quiet)).toBe(true)
    // Once while in progress, once for the final sweep.
    expect(api.list).toHaveBeenCalledTimes(2)
    expect(api.create).toHaveBeenCalledTimes(2)
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
  })

  it('gives up (false) when it can never tell', async () => {
    const api = client()
    api.create.mockRejectedValue(new EnvironmentProviderError('unavailable', 'down'))
    expect(await reclaimCancelledCreate(api, BODY, 'create:k1', { ...quiet, attempts: 3 })).toBe(
      false
    )
  })
})

describe('createSandboxWithProgress cancel', () => {
  const spec = { workspaceId: 'web-1', machineSize: 'standard', idempotencyKey: 'create:k1' }

  it('cancelled while the create was in flight: reclaims by key, then reports the cancel', async () => {
    const api = client()
    const controller = new AbortController()
    api.create.mockImplementationOnce(async () => {
      controller.abort()
      throw new EnvironmentProviderError('aborted', 'Cancelled.')
    })
    await expect(
      createSandboxWithProgress(api, spec, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'aborted' })
    // The replay (no signal, same key) found the sandbox and deleted it.
    expect(api.create).toHaveBeenLastCalledWith(expect.anything(), undefined, 'create:k1')
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
  })

  it('cancelled just as the create answered: deletes the sandbox and reports the cancel', async () => {
    const api = client()
    const controller = new AbortController()
    api.create.mockImplementationOnce(async () => {
      controller.abort()
      return READY
    })
    await expect(
      createSandboxWithProgress(api, spec, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'aborted' })
    expect(api.destroy).toHaveBeenCalledWith('sbx_1')
    expect(api.create).toHaveBeenCalledTimes(1)
  })

  it('EP-5: a cancel whose sandbox could not be confirmed deleted says so (reason), not a plain cancel', async () => {
    const api = client()
    const controller = new AbortController()
    const create: ReclaimClient['create'] = async (_body, signal) => {
      if (signal) {
        controller.abort()
        throw new EnvironmentProviderError('aborted', 'Cancelled.')
      }
      throw new EnvironmentProviderError('unavailable', 'down')
    }
    api.create.mockImplementation(create)
    vi.useFakeTimers()
    try {
      const outcome = expect(
        createSandboxWithProgress(api, spec, { signal: controller.signal })
      ).rejects.toMatchObject({ code: 'aborted', reason: CANCEL_CLEANUP_UNCONFIRMED })
      // Every replay (2 min of them) fails: the retry waits run out.
      await vi.runAllTimersAsync()
      await outcome
    } finally {
      vi.useRealTimers()
    }
  })

  it('EP-5: cancelled as it answered and the delete failed: not confirmed', async () => {
    const api = client()
    const controller = new AbortController()
    api.create.mockImplementationOnce(async () => {
      controller.abort()
      return READY
    })
    api.destroy.mockRejectedValueOnce(new EnvironmentProviderError('unavailable', 'down'))
    await expect(
      createSandboxWithProgress(api, spec, { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'aborted', reason: CANCEL_CLEANUP_UNCONFIRMED })
  })

  it('not cancelled: no replay, no delete', async () => {
    const api = client()
    await expect(createSandboxWithProgress(api, spec, {})).resolves.toBe(READY)
    expect(api.create).toHaveBeenCalledTimes(1)
    expect(api.destroy).not.toHaveBeenCalled()
  })
})
