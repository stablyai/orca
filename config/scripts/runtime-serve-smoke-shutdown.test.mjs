import { execFileSync } from 'node:child_process'
import { SERVE_STOP_READY, SERVE_STOP_REQUEST } from '../../src/shared/serve-supervisor-control.ts'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  prepareServerShutdown,
  stopServer,
  SHUTDOWN_TIMEOUT_MS
} from './runtime-serve-smoke-shutdown.mjs'

const probe = vi.fn()
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function launcher() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = vi.fn(() => true)
  child.stdout = { destroy: vi.fn() }
  child.stderr = { destroy: vi.fn() }
  return child
}

it('waits for the actual Windows server after launcher loss without requiring descendant pipe closure', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  probe.mockReturnValue('live')
  const child = launcher()
  let done = false
  const stopped = stopServer(child, undefined, true, 123, probe).then(() => {
    done = true
  })
  child.signalCode = 'SIGTERM'
  child.emit('close', null, 'SIGTERM')
  await vi.advanceTimersByTimeAsync(100)
  expect(done).toBe(false)
  probe.mockReturnValue('exited')
  await vi.advanceTimersByTimeAsync(50)
  await stopped
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
  expect(vi.getTimerCount()).toBe(0)
})

it('does not accept unverifiable server liveness as successful shutdown', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  probe.mockReturnValue('unverifiable')
  const child = launcher()
  const stopped = expect(stopServer(child, undefined, true, 123, probe)).rejects.toThrow(
    'did not exit'
  )
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
  await stopped
  expect(vi.getTimerCount()).toBe(0)
})

it('retains normal nonzero-exit rejection without Windows owner loss', async () => {
  const child = launcher()
  const stopped = expect(stopServer(child)).rejects.toThrow('shutdown failed: 7')
  child.emit('close', 7, null)
  await stopped
})

it('accepts clean macOS exit only after the serving PID exits, despite open helper pipes', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  probe.mockReturnValue('live')
  const child = launcher()
  const stopped = stopServer(child, undefined, false, 123, probe)
  child.exitCode = 0
  child.emit('exit', 0, null)
  await vi.advanceTimersByTimeAsync(50)
  expect(child.stdout.destroy).not.toHaveBeenCalled()
  probe.mockReturnValue('exited')
  await vi.advanceTimersByTimeAsync(50)
  await stopped
  expect(child.stdout.destroy).toHaveBeenCalledOnce()
  expect(child.stderr.destroy).toHaveBeenCalledOnce()
  expect(child.listenerCount('exit')).toBe(0)
  expect(child.listenerCount('close')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('does not accept a dead server while its launcher is still running', async () => {
  vi.useFakeTimers()
  probe.mockReturnValue('exited')
  const child = launcher()
  const stopped = expect(stopServer(child, undefined, false, 123, probe)).rejects.toThrow(
    'did not exit'
  )
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS)
  await stopped
  expect(child.stdout.destroy).not.toHaveBeenCalled()
})

it('queues direct-runtime shutdown until IPC is ready and never uses Windows SIGTERM', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const child = launcher()
  child.connected = true
  child.send = vi.fn((_message, callback) => callback(null))
  prepareServerShutdown(child)
  const stopped = stopServer(child)
  expect(child.send).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('message', SERVE_STOP_READY)
  expect(child.send).toHaveBeenCalledWith(SERVE_STOP_REQUEST, expect.any(Function))
  child.exitCode = 0
  child.emit('exit', 0, null)
  await stopped
  expect(child.listenerCount('message')).toBe(0)
})

it('loads the shutdown harness in native Node without a test transform', () => {
  const moduleUrl = new URL('./runtime-serve-smoke-shutdown.mjs', import.meta.url).href
  expect(() =>
    execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleUrl)})`],
      { windowsHide: true, timeout: 10_000, stdio: 'pipe' }
    )
  ).not.toThrow()
})
