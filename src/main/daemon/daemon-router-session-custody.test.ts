import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { createAdapter } from './daemon-pty-router-test-adapter'

describe('router custody admission', () => {
  it.each(['attach', 'attachOnly', 'spawn'])(
    'preserves ownership and unblocks %s after shutdown cancellation',
    async (operation) => {
      const legacy = createAdapter('legacy', ['sleeping'], 29)
      const current = createAdapter('current', [], 36)
      const router = new DaemonPtyRouter({ current, legacy: [legacy] })
      await router.discoverLegacySessions()
      let cancel!: () => void
      const gate = new Promise<void>((resolve) => {
        cancel = resolve
      })
      let started = false
      vi.mocked(legacy.shutdown).mockImplementationOnce(async () => {
        started = true
        await gate
        throw new Error('checkpoint deadline expired')
      })
      const sleeping = router
        .shutdown('sleeping', { keepHistory: true })
        .catch((error: Error) => error)
      await vi.waitFor(() => expect(started).toBe(true))
      const admission =
        operation === 'attach'
          ? router.attach('sleeping')
          : router.spawn({
              sessionId: 'sleeping',
              cols: 80,
              rows: 24,
              attachOnly: operation === 'attachOnly'
            })
      try {
        await router.spawn({ sessionId: 'different-id', cols: 80, rows: 24 })
        expect(legacy.attach).not.toHaveBeenCalled()
        expect(legacy.spawn).not.toHaveBeenCalled()
      } finally {
        cancel()
      }
      expect(await sleeping).toEqual(new Error('checkpoint deadline expired'))
      await admission
      router.write('sleeping', 'still-live')
      expect(legacy.write).toHaveBeenCalledWith('sleeping', 'still-live')
      expect(current.write).not.toHaveBeenCalled()
      expect(legacy.ackColdRestore).not.toHaveBeenCalled()
      legacy.emitExit('sleeping', 0)
      router.write('sleeping', 'after-exit')
      expect(current.write).toHaveBeenCalledWith('sleeping', 'after-exit')
      router.disposeRouterOnly()
    }
  )
})
