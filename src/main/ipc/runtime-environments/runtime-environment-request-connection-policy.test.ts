import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../../wsl/wsl-host-service-instance', () => ({ getWslHostService: () => null }))

import {
  trackWslHostRequestIdle,
  WSL_HOST_REQUEST_IDLE_CLOSE_MS
} from './runtime-environment-request-connection-policy'

const wsl = (): boolean => true
const notWsl = (): boolean => false

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

it('leaves SSH and paired servers on the client’s own idle close', async () => {
  const connection = { close: vi.fn() }
  await trackWslHostRequestIdle('ssh:box', connection, Promise.resolve('ok'), notWsl)
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS * 10)
  expect(connection.close).not.toHaveBeenCalled()
})

it('closes a WSL host’s request socket once it has been idle, so its bridge goes too', async () => {
  const connection = { close: vi.fn() }
  await expect(
    trackWslHostRequestIdle('wsl:ubuntu', connection, Promise.resolve('ok'), wsl)
  ).resolves.toBe('ok')
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS - 1)
  expect(connection.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(connection.close).toHaveBeenCalledOnce()
})

it('never closes under a request still in flight, and restarts the wait on each request', async () => {
  const connection = { close: vi.fn() }
  const slow = Promise.withResolvers<string>()
  void trackWslHostRequestIdle('wsl:ubuntu', connection, slow.promise, wsl)
  await trackWslHostRequestIdle('wsl:ubuntu', connection, Promise.resolve('fast'), wsl)
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS * 2)
  expect(connection.close).not.toHaveBeenCalled()
  slow.resolve('done')
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS / 2)
  await trackWslHostRequestIdle('wsl:ubuntu', connection, Promise.resolve('again'), wsl)
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS - 1)
  expect(connection.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(connection.close).toHaveBeenCalledOnce()
})

it('counts a failed request as settled', async () => {
  const connection = { close: vi.fn() }
  await expect(
    trackWslHostRequestIdle('wsl:ubuntu', connection, Promise.reject(new Error('x')), wsl)
  ).rejects.toThrow('x')
  await vi.advanceTimersByTimeAsync(WSL_HOST_REQUEST_IDLE_CLOSE_MS)
  expect(connection.close).toHaveBeenCalledOnce()
})
