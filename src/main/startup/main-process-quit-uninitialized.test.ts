import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const cleanupModules = [
  '../ipc/ssh/ssh-shutdown-drain',
  '../runtime/structured-agent-session-runtime',
  '../ipc/desktop-browser-bridge-wiring',
  '../browser/local-ssh-browser-route',
  '../runtime/rpc/methods/index'
]

afterEach(() => {
  vi.doUnmock('electron')
  vi.doUnmock('./main-process-state')
  for (const path of cleanupModules) {
    vi.doUnmock(path)
  }
  vi.resetModules()
})

it('quits with unused subsystems without importing their cleanup, even dynamically', async () => {
  vi.resetModules()
  const app = Object.assign(new EventEmitter(), { quit: vi.fn() })
  const loadCleanup = vi.fn(() => {
    throw new Error('unused cleanup loaded')
  })
  vi.doMock('electron', () => ({ app }))
  vi.doMock('./main-process-state', () => ({ mainProcessState: {} }))
  for (const path of cleanupModules) {
    vi.doMock(path, loadCleanup)
  }
  const { installMainProcessQuitHandlers } = await import('./main-process-quit')
  installMainProcessQuitHandlers()
  app.emit('before-quit', { defaultPrevented: false })
  app.emit('will-quit', { preventDefault: vi.fn() })
  await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce())
  expect(loadCleanup).not.toHaveBeenCalled()
})
