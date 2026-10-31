import { afterEach, expect, it, vi } from 'vitest'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { closeOmpRpcAdapterFixtures, setupOmpRpcAdapter } from './rpc-session-adapter.test-fixture'
import { supportsOmpSubagentStop } from './rpc-subagent-stops'
import type { PiRpcConnection } from '../pi/rpc-session'

afterEach(closeOmpRpcAdapterFixtures)

const lifecycle = (id: string, status = 'started') => ({
  type: 'subagent_lifecycle',
  payload: { id, status, agent: 'task', parentToolCallId: `call-${id}` }
})

async function setup() {
  const h = await setupOmpRpcAdapter('attempt', (connection) => {
    connection.requestOverride = (command) => {
      if (command !== 'cancel_subagent') {
        return undefined
      }
      connection.receive({ type: 'agent_settled' })
      return Promise.reject(
        new JsonlRpcResponseError(command, '`subagentId` must be a non-empty string.')
      )
    }
  })
  const requests: unknown[] = []
  const original = h.connection.request.bind(h.connection)
  let cancel: (id: string) => Promise<unknown> = async () => ({ cancelled: true })
  h.connection.request = async (command: string, params?: Record<string, unknown>) => {
    if (command === 'cancel_subagent') {
      requests.push(params)
      if (typeof params?.subagentId !== 'string') {
        throw new Error('Missing native subagent ID')
      }
      return cancel(params.subagentId)
    }
    return original(command)
  }
  return {
    ...h,
    requests,
    setCancel: (handler: typeof cancel) => {
      cancel = handler
    }
  }
}

it('requires a side-effect-free native validation response before enabling cancellation', async () => {
  const request = vi.fn<PiRpcConnection['request']>()
  for (const response of [
    new JsonlRpcResponseError('cancel_subagent', 'Unknown command: cancel_subagent'),
    new Error('Disconnected'),
    new JsonlRpcResponseError('cancel_subagent', 'Subagent event bus is unavailable')
  ]) {
    request.mockRejectedValueOnce(response)
    expect(await supportsOmpSubagentStop({ request })).toBe(false)
  }
  request.mockResolvedValueOnce({ cancelled: true })
  expect(await supportsOmpSubagentStop({ request })).toBe(false)
  request.mockRejectedValueOnce(
    new JsonlRpcResponseError('cancel_subagent', '`subagentId` must be a non-empty string.')
  )
  expect(await supportsOmpSubagentStop({ request })).toBe(true)
  expect(request.mock.calls.every(([, params]) => params?.subagentId === '')).toBe(true)
})

it('stops only native children and preserves acknowledged targets when a later cancellation fails', async () => {
  const h = await setup()
  for (const id of ['one', 'two']) {
    h.connection.receive(lifecycle(id))
  }
  await vi.waitFor(() =>
    expect(h.childWork.mock.calls.flatMap(([entries]) => entries)).toContainEqual(
      expect.objectContaining({ type: 'live', child: expect.objectContaining({ stoppable: true }) })
    )
  )
  const acknowledge = vi.fn()
  const stop = (taskIds: string[], fence = 1) =>
    h.adapter.stopBackgroundTasks({
      sessionId: 'omp-test',
      fence,
      taskIds,
      acknowledge
    })
  await expect(async () => stop(['one', 'omp-job:bg_1'])).rejects.toThrow(
    'not a live native subagent'
  )
  await expect(async () => stop(['one'], 99)).rejects.toThrow()
  expect(h.requests).toEqual([])
  h.setCancel(async (id) => {
    if (id === 'two') {
      throw new Error('Disconnected while cancelling second child')
    }
    return { cancelled: true }
  })
  await expect(stop(['one', 'one', 'two'])).rejects.toThrow('Disconnected')
  expect(h.requests).toEqual([{ subagentId: 'one' }, { subagentId: 'two' }])
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ taskId: 'one' })
  expect(h.connection.closed).toBe(false)
})

it('does not acknowledge native refusals or cancel a replacement child with a stale response', async () => {
  const h = await setup()
  h.connection.receive(lifecycle('child'))
  const acknowledge = vi.fn()
  const stop = () =>
    h.adapter.stopBackgroundTasks({
      sessionId: 'omp-test',
      fence: 1,
      taskIds: ['child'],
      acknowledge
    })
  h.setCancel(async () => ({ cancelled: false }))
  await expect(stop()).resolves.toEqual({ cancelled: false, stillRunning: true })
  expect(acknowledge).not.toHaveBeenCalled()
  const pending = Promise.withResolvers<unknown>()
  h.setCancel(() => pending.promise)
  const stopping = stop()
  h.connection.receive(lifecycle('child', 'completed'))
  h.connection.receive(lifecycle('child'))
  pending.resolve({ cancelled: true })
  await stopping
  expect(acknowledge).not.toHaveBeenCalled()
  h.setCancel(async () => ({ cancelled: true }))
  await expect(stop()).resolves.toEqual({ cancelled: true })
  expect(acknowledge).toHaveBeenCalledExactlyOnceWith({ taskId: 'child' })
})

it('does not acknowledge a cancellation after the provider connection exits', async () => {
  const h = await setup()
  h.connection.receive(lifecycle('child'))
  const pending = Promise.withResolvers<unknown>()
  h.setCancel(() => pending.promise)
  const acknowledge = vi.fn()
  const stopping = h.adapter.stopBackgroundTasks({
    sessionId: 'omp-test',
    fence: 1,
    taskIds: ['child'],
    acknowledge
  })
  h.connection.exit()
  pending.resolve({ cancelled: true })
  await stopping
  expect(acknowledge).not.toHaveBeenCalled()
})
