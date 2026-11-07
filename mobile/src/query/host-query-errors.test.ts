import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { createOrcaQueryClient } from './orca-query-client'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('retries a read cut by a connection migration once and lands its data', async () => {
  const queryClient = createOrcaQueryClient()
  const queryFn = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new LogicalClientCutoverError())
    .mockResolvedValueOnce('rows')

  const read = queryClient.query({ queryKey: ['orca', 'host-1', 'test.read'], queryFn })
  await vi.advanceTimersByTimeAsync(250)

  await expect(read).resolves.toBe('rows')
  expect(queryFn).toHaveBeenCalledTimes(2)
})

it('leaves a read refused while disconnected to the connected edge', async () => {
  const queryClient = createOrcaQueryClient()
  const queryFn = vi
    .fn<() => Promise<string>>()
    .mockRejectedValue(new Error('Not connected: test.read'))

  const read = queryClient.query({ queryKey: ['orca', 'host-1', 'test.read'], queryFn })
  const settled = expect(read).rejects.toThrow('Not connected: test.read')
  await vi.advanceTimersByTimeAsync(5_000)

  await settled
  expect(queryFn).toHaveBeenCalledTimes(1)
})
