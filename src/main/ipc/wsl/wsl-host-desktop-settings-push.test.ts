import { afterEach, describe, expect, it, vi } from 'vitest'
import { addWslHostThenSeedPermission } from './wsl-host-desktop-settings-push'

vi.mock('../runtime-environments/requests/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

const ADDED = { ok: true as const, environmentId: 'wsl-ubuntu' }

describe('addWslHostThenSeedPermission', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns only after the seed finishes', async () => {
    const order: string[] = []
    const result = await addWslHostThenSeedPermission(
      async () => ADDED,
      async (environmentId) => {
        await Promise.resolve()
        order.push(`seeded ${environmentId}`)
      }
    )
    order.push('returned')
    expect(result).toBe(ADDED)
    expect(order).toEqual(['seeded wsl-ubuntu', 'returned'])
  })

  it('still reports the Add when the seed throws', async () => {
    await expect(
      addWslHostThenSeedPermission(
        async () => ADDED,
        async () => {
          throw new Error('host refused')
        }
      )
    ).resolves.toBe(ADDED)
  })

  it('still reports the Add when the seed throws synchronously', async () => {
    await expect(
      addWslHostThenSeedPermission(
        async () => ADDED,
        () => {
          throw new Error('settings unavailable')
        }
      )
    ).resolves.toBe(ADDED)
  })

  it('stops waiting for a slow seed at the deadline', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = addWslHostThenSeedPermission(
      async () => ADDED,
      () => new Promise<void>(() => {}),
      5_000
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(pending).resolves.toBe(ADDED)
  })

  it('skips the seed when Add fails', async () => {
    const refused = { ok: false as const, kind: 'failed' as const, message: 'no distro' }
    const seed = vi.fn(async () => {})
    await expect(addWslHostThenSeedPermission(async () => refused, seed)).resolves.toBe(refused)
    expect(seed).not.toHaveBeenCalled()
  })
})
