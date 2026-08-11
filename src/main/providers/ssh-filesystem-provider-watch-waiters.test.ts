import { describe, expect, it, vi } from 'vitest'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { registerSshFilesystemWatch, type WatchRegistration } from './ssh-filesystem-provider-watch'

describe('registerSshFilesystemWatch waiters', () => {
  it('removes ten thousand cancelled callers while one registration anchor remains', async () => {
    let resolveWatch: () => void = () => undefined
    const mux = {
      request: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveWatch = resolve
          })
      ),
      notify: vi.fn()
    } as unknown as SshChannelMultiplexer
    const registrations = new Map<string, WatchRegistration>()
    const watch = (signal?: AbortSignal) =>
      registerSshFilesystemWatch({
        mux,
        registrations,
        rootPath: '/home/user/project',
        callback: vi.fn(),
        signal,
        disposed: () => false
      })
    const anchor = watch()
    const controllers = Array.from({ length: 10_000 }, () => new AbortController())
    const cancelled = controllers.map((controller) =>
      watch(controller.signal).catch((error) => error)
    )

    for (const controller of controllers) {
      controller.abort()
    }
    await Promise.all(cancelled)

    expect(registrations.values().next().value?.setupWaiters.waiterCount).toBe(1)
    resolveWatch()
    await expect(anchor).resolves.toEqual(expect.any(Function))
    expect(registrations.values().next().value?.setupWaiters.waiterCount).toBe(0)
  })
})
