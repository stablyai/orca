import { expect, it, vi } from 'vitest'
import { QuitTaskRegistry } from './quit-task-registry'

const context = { isUpdate: false, shutdownDaemon: false }

it('invokes registered tasks synchronously in phase order without waiting for earlier drains', async () => {
  const registry = new QuitTaskRegistry()
  const trace: string[] = []
  const drain = Promise.withResolvers<void>()
  registry.register('ssh', 'detach', () => {
    trace.push('detach')
    return drain.promise.then(() => trace.push('drained'))
  })
  registry.register('ssh', 'invalidate', () => {
    trace.push('invalidate')
  })
  registry.register('daemon', 'disconnect', () => {
    trace.push('daemon')
  })

  const pending = registry.run('ssh', context)
  expect(trace).toEqual(['detach', 'invalidate'])
  drain.resolve()
  await pending
  expect(trace).toEqual(['detach', 'invalidate', 'drained'])
})

it('replaces restarted owners and an old disposer cannot unregister the replacement', async () => {
  const registry = new QuitTaskRegistry()
  const retired = vi.fn()
  const current = vi.fn()
  const unregisterRetired = registry.register('tray', 'tray', retired)
  const unregisterCurrent = registry.register('tray', 'tray', current)
  unregisterRetired()
  await registry.run('tray', context)
  expect(retired).not.toHaveBeenCalled()
  expect(current).toHaveBeenCalledOnce()
  unregisterCurrent()
  await registry.run('tray', context)
  expect(current).toHaveBeenCalledOnce()
})

it('finishes later cleanup after both synchronous throws and asynchronous rejections', async () => {
  const registry = new QuitTaskRegistry()
  const failure = new Error('cleanup failed')
  const report = vi.spyOn(console, 'error').mockImplementation(() => {})
  const cleanup = vi.fn()
  registry.register('filesystem-watchers', 'throwing', () => {
    throw failure
  })
  registry.register('filesystem-watchers', 'rejecting', () => Promise.reject(failure))
  registry.register('filesystem-watchers', 'cleanup', cleanup)
  try {
    await registry.run('filesystem-watchers', context)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith('[shutdown] throwing failed:', failure)
    expect(report).toHaveBeenCalledWith('[shutdown] rejecting failed:', failure)
  } finally {
    report.mockRestore()
  }
})

it('fences an unused phase synchronously without replaying late registrations', async () => {
  const registry = new QuitTaskRegistry()
  const drain = Promise.withResolvers<void>()
  registry.register('ssh', 'detach', () => {
    expect(registry.hasStarted('ssh')).toBe(true)
    return drain.promise
  })
  expect(registry.hasStarted('ssh')).toBe(false)
  const pending = registry.run('ssh', context)
  expect(registry.hasStarted('ssh')).toBe(true)
  expect(registry.hasStarted('browser-client-hosts')).toBe(false)
  await registry.run('browser-client-hosts', context)
  expect(registry.hasStarted('browser-client-hosts')).toBe(true)
  const late = vi.fn()
  registry.register('browser-client-hosts', 'late-owner', late)
  expect(late).not.toHaveBeenCalled()
  drain.resolve()
  await pending
  expect(registry.hasStarted('ssh')).toBe(true)
})
