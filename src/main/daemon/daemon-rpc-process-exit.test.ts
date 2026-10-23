import { afterEach, expect, it, vi } from 'vitest'
import { exitDaemonAfterRpcShutdown } from './daemon-rpc-process-exit'

afterEach(() => vi.restoreAllMocks())

it('uses ordinary exit for normal RPC shutdown without signaling any process', () => {
  const stopped = new Error('exit intercepted')
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw stopped
  })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  expect(() => exitDaemonAfterRpcShutdown()).toThrow(stopped)
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(kill).not.toHaveBeenCalled()
})

it('signals only its own process after verified stalled-owner completion', () => {
  const stopped = new Error('exit intercepted')
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw stopped
  })
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  expect(() => exitDaemonAfterRpcShutdown('verified-stalled-owner')).toThrow(stopped)
  expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGKILL')
  expect(exit).toHaveBeenCalledExactlyOnceWith(0)
  expect(kill.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0])
})
