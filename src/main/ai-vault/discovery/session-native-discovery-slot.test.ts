import { expect, it, vi } from 'vitest'
import { withNativeDiscoverySlot } from './session-native-discovery-slot'

it('removes a cancelled native discovery waiter without touching disk or blocking its successor', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let admitted = 0
  const active = Array.from({ length: 8 }, () =>
    withNativeDiscoverySlot(async () => {
      admitted++
      await held
    })
  )
  await vi.waitFor(() => expect(admitted).toBe(8))
  const controller = new AbortController()
  const touch = vi.fn(async () => undefined)
  const cancelled = withNativeDiscoverySlot(touch, controller.signal)
  const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejection
  expect(touch).not.toHaveBeenCalled()
  const next = vi.fn(async () => 'ready')
  const successor = withNativeDiscoverySlot(next)
  release()
  await Promise.all(active)
  await expect(successor).resolves.toBe('ready')
  expect(next).toHaveBeenCalledOnce()
})
