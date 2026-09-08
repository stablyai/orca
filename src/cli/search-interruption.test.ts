import { expect, it, vi } from 'vitest'

const call = vi.hoisted(() => vi.fn())
vi.mock('./runtime-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RuntimeClient: class {
    isRemote = false
    call = call
  }
}))

import { main } from './index'

it('preserves Ctrl-C exit status through the single-host CLI entrypoint', async () => {
  const previous = process.exitCode
  const listeners = process.listenerCount('SIGINT')
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  call.mockImplementation(() => {
    queueMicrotask(() => process.emit('SIGINT'))
    return new Promise(() => {})
  })
  try {
    process.exitCode = 0
    await main(['search', '--agent-session', 'fixture', '--json'])
    expect(call).toHaveBeenCalledTimes(1)
    expect(process.exitCode).toBe(130)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
    expect(error).not.toHaveBeenCalled()
  } finally {
    process.exitCode = previous
    log.mockRestore()
    error.mockRestore()
  }
})
