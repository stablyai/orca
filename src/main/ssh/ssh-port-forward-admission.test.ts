import { expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import { SshPortForwardManager } from './ssh-port-forward'
import type { PortForwardStartOptions, StartedPortForward } from './ssh-port-forward-provider'
import { SshPortForwardAdmission } from './ssh-port-forward-admission'

function fixture() {
  const started: (StartedPortForward & { options: PortForwardStartOptions })[] = []
  const waitForStart = vi.fn(async () => {})
  const manager = new SshPortForwardManager({}, [
    {
      canHandle: () => true,
      start: async (_connection, options) => {
        await waitForStart()
        const forward = {
          entry: { ...options },
          options,
          close: vi.fn(async () => {}),
          dispose: vi.fn(),
          fenceForDrain: vi.fn(() => ({ drain: vi.fn(async () => {}), assertDrained: vi.fn() }))
        }
        started.push(forward)
        return forward
      }
    }
  ])
  const connection = {} as SshConnection
  const add = (targetId = 'target') =>
    manager.addForward(targetId, connection, 3000, 'localhost', 8080)
  return { started, waitForStart, manager, connection, add }
}

it('blocks accepted socket admission before a pending start has published its listener', async () => {
  let options!: PortForwardStartOptions
  const pending = Promise.withResolvers<void>()
  const manager = new SshPortForwardManager({}, [
    {
      canHandle: () => true,
      start: async (_connection, selected) => {
        options = selected
        await pending.promise
        return {
          entry: { ...selected },
          close: async () => {},
          dispose: () => {},
          fenceForDrain: () => ({ drain: async () => {}, assertDrained: () => {} })
        }
      }
    }
  ])
  const adding = manager.addForward('target', {} as SshConnection, 0, 'remote', 80)
  expect(() => options.assertAdmission?.()).not.toThrow()
  const fence = manager.fenceForwardAdmission('target')
  expect(() => options.assertAdmission?.()).toThrow('admission_closed')
  pending.resolve()
  await adding
  await fence.drain()
  fence.assertDrained()
})

it('retains a removed listener in the drain cohort until its work settles', async () => {
  const f = fixture()
  const entry = await f.add()
  const pending = Promise.withResolvers<void>()
  const drain = vi.fn(() => pending.promise)
  f.started[0].fenceForDrain = vi.fn(() => ({ drain, assertDrained: vi.fn() }))
  f.manager.removeForward(entry.id)
  expect(f.manager.listForwards()).toEqual([])
  const fence = f.manager.fenceForwardAdmission('target')
  let settled = false
  const waiting = fence.drain().then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(drain).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  pending.resolve()
  await waiting
})

it('refuses an opaque provider even after its visible row was removed', async () => {
  const f = fixture()
  const entry = await f.add()
  delete f.started[0].fenceForDrain
  f.manager.removeForward(entry.id)
  const fence = f.manager.fenceForwardAdmission('target')
  await expect(fence.drain()).rejects.toThrow()
  expect(() => fence.assertDrained()).toThrow()
  expect(() => fence.release(() => {})).toThrow('capability_unavailable')
})

it('retains failed closure evidence even if a later close retry succeeds', async () => {
  const f = fixture()
  const entry = await f.add()
  vi.mocked(f.started[0].close).mockRejectedValueOnce(new Error('close uncertain'))
  await expect(f.manager.removeForwardAndWait(entry.id)).rejects.toThrow('close uncertain')
  const fence = f.manager.fenceForwardAdmission('target')
  await expect(fence.drain()).rejects.toThrow('close uncertain')
  await expect(fence.drain()).rejects.toThrow('close uncertain')
})

it('retains old-instance failure without removing a same-ID replacement', async () => {
  const f = fixture()
  const entry = await f.add()
  const replacement = await f.manager.updateForward(entry.id, f.connection, 3001, 'remote', 80)
  f.started[0].options.onUnexpectedClose?.(entry, {
    kind: 'unexpected-exit',
    detail: 'old transport lost'
  })
  expect(f.manager.listForwards()).toEqual([replacement])
  const fence = f.manager.fenceForwardAdmission('target')
  await expect(fence.drain()).rejects.toThrow('old transport lost')
})

it('releases a cohort only after retired receipts cover every historical instance', async () => {
  const f = fixture()
  const entry = await f.add()
  vi.mocked(f.started[0].close).mockImplementationOnce(async () => {
    Object.assign(f.started[0], { retirementConfirmed: true })
  })
  await f.manager.removeForwardAndWait(entry.id)
  const fence = f.manager.fenceForwardAdmission('target')
  await fence.drain()
  fence.assertDrained()
  fence.release(() => {})
  await expect(f.add()).resolves.toMatchObject({ connectionId: 'target' })
})

it('blocks new adds/updates before effects while allowing unrelated targets', async () => {
  const f = fixture()
  const original = await f.add()
  const fence = f.manager.fenceForwardAdmission('target')
  await fence.drain()
  fence.assertDrained()
  await expect(f.add()).rejects.toThrow('admission_closed')
  await expect(
    f.manager.updateForward(original.id, f.connection, 3001, 'localhost', 8081)
  ).rejects.toThrow('admission_closed')
  expect(f.started[0].close).not.toHaveBeenCalled()
  expect(f.manager.listForwards('target')).toEqual([original])
  await expect(f.add('other')).resolves.toMatchObject({ connectionId: 'other' })
})

it('drains an admitted add before the captured listener cohort is selected', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.waitForStart.mockReturnValueOnce(pending.promise)
  const adding = f.add()
  const fence = f.manager.fenceForwardAdmission('target')
  expect(fence.assertDrained).toThrow('publication_unconfirmed')
  let drained = false
  const draining = fence.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  pending.resolve()
  await adding
  await draining
  const cleanup = f.manager.captureForwardCleanup('target')
  await cleanup.removeAndWait()
  cleanup.assertRemoved()
  expect(f.started[0].close).toHaveBeenCalledOnce()
  expect(f.manager.listForwards()).toEqual([])
})

it('drains a previously admitted update through replacement publication', async () => {
  const f = fixture()
  const original = await f.add()
  const pending = Promise.withResolvers<void>()
  vi.mocked(f.started[0].close).mockReturnValueOnce(pending.promise)
  const updating = f.manager.updateForward(original.id, f.connection, 3001, 'localhost', 8081)
  const fence = f.manager.fenceForwardAdmission('target')
  const draining = fence.drain()
  pending.resolve()
  const replacement = await updating
  await draining
  fence.assertDrained()
  expect(f.manager.listForwards()).toEqual([replacement])
  const cleanup = f.manager.captureForwardCleanup('target')
  await cleanup.removeAndWait()
  expect(f.started[1].close).toHaveBeenCalledOnce()
})

it('retains failed publication evidence and keeps admission closed on retry', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.waitForStart.mockReturnValueOnce(pending.promise)
  const adding = f.add()
  const additionFailure = expect(adding).rejects.toThrow('start uncertain')
  const fence = f.manager.fenceForwardAdmission('target')
  const draining = expect(fence.drain()).rejects.toThrow('start uncertain')
  pending.reject(new Error('start uncertain'))
  await Promise.all([additionFailure, draining])
  await expect(fence.drain()).rejects.toThrow('start uncertain')
  expect(fence.assertDrained).toThrow('publication_unconfirmed')
  await expect(f.add()).rejects.toThrow('admission_closed')
})

it('aborting observation keeps admission closed and the original drain retryable', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.waitForStart.mockReturnValueOnce(pending.promise)
  const adding = f.add()
  const fence = f.manager.fenceForwardAdmission('target')
  const controller = new AbortController()
  const draining = fence.drain(controller.signal)
  controller.abort(new Error('observation stopped'))
  await expect(draining).rejects.toThrow('observation stopped')
  await expect(f.add()).rejects.toThrow('admission_closed')
  pending.resolve()
  await adding
  await fence.drain()
  fence.assertDrained()
})

it('releases only under caller authority and invalidates stale fence handles', async () => {
  const f = fixture()
  const fence = f.manager.fenceForwardAdmission('target')
  expect(() => f.manager.fenceForwardAdmission('target')).toThrow('already_closed')
  expect(() =>
    fence.release(() => {
      throw new Error('not completed')
    })
  ).toThrow('not completed')
  await expect(f.add()).rejects.toThrow('admission_closed')
  const released = fence.release(() => {})
  released.assertReleased()
  await f.add()
  expect(released.assertReleased).toThrow('released_admission_changed')
  const replacement = f.manager.fenceForwardAdmission('target')
  expect(fence.assertClosed).toThrow('fence_changed')
  expect(() => fence.release(() => {})).toThrow('fence_changed')
  replacement.assertClosed()
})

it('does not restore a released proof after later admission fails or a later fence is removed', async () => {
  const admission = new SshPortForwardAdmission()
  const first = admission.fence('target')
  await first.drain()
  const released = first.release(() => {})
  await expect(
    admission.run('target', async () => {
      throw new Error('start failed')
    })
  ).rejects.toThrow('start failed')
  expect(released.assertReleased).toThrow('released_admission_changed')
  const next = admission.fence('target')
  await next.drain()
  const nextRelease = next.release(() => {})
  nextRelease.assertReleased()
  expect(released.assertReleased).toThrow('released_admission_changed')
})
