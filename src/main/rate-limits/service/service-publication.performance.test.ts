import { beforeEach, expect, it, vi } from 'vitest'
import type { RateLimitState } from '../../../shared/agent-usage/rate-limits/rate-limit-types'
import { RateLimitService } from './rate-limit-service'
import { okProvider } from './rate-limit-service-test-harness'

const presence = vi.hoisted(() => ({ cookie: vi.fn(), minimax: vi.fn(), zcode: vi.fn() }))
vi.mock('../../minimax/minimax-cookie-store', () => ({ hasMiniMaxSessionCookie: presence.cookie }))
vi.mock('../../minimax/minimax-api-key-store', () => ({ hasMiniMaxApiKey: presence.minimax }))
vi.mock('../../zcode/zcode-plan-api-key-store', () => ({ hasZcodePlanApiKey: presence.zcode }))

class PublicationService extends RateLimitService {
  constructor() {
    super()
    this.inactiveCodexAccountsResolver = () => [
      { id: 'inactive', resolveHome: () => ({ kind: 'skip' }) }
    ]
  }
  change(value: number): void {
    this.updateState({ ...this.state, codex: okProvider('codex', value) })
  }
  inactive(value: number): Promise<void> {
    this.inactiveCodexCache.set('inactive', okProvider('codex', value))
    return this.pushToRenderer()
  }
}
beforeEach(() => {
  presence.cookie.mockReset().mockResolvedValue(false)
  presence.minimax.mockReset().mockResolvedValue(false)
  presence.zcode.mockReset().mockResolvedValue(false)
})

it.each([100, 1000])(
  'coalesces %i overlapping active and inactive publications before credential admission',
  async (count) => {
    const service = new PublicationService()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<boolean>()
    presence.cookie.mockImplementationOnce(() => {
      entered.resolve()
      return release.promise
    })
    const received: RateLimitState[] = []
    service.onStateChange((state) => received.push(state))
    const publishing = service.inactive(0)
    await entered.promise
    for (let value = 1; value <= count; value++) {
      service.change(value)
      void service.inactive(value)
    }
    expect(presence.cookie).toHaveBeenCalledTimes(1)
    expect(presence.minimax).toHaveBeenCalledTimes(1)
    expect(presence.zcode).toHaveBeenCalledTimes(1)
    release.resolve(false)
    await publishing
    expect(presence.cookie).toHaveBeenCalledTimes(2)
    expect(presence.minimax).toHaveBeenCalledTimes(2)
    expect(presence.zcode).toHaveBeenCalledTimes(2)
    expect(received).toHaveLength(1)
    expect(received[0].codex?.session?.usedPercent).toBe(count)
    expect(received[0].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(count)
  }
)

it('drops pending and late publication work on stop', async () => {
  const service = new PublicationService()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<boolean>()
  presence.cookie.mockImplementationOnce(() => {
    entered.resolve()
    return release.promise
  })
  const listener = vi.fn()
  service.onStateChange(listener)
  const publishing = service.inactive(1)
  await entered.promise
  service.change(2)
  service.stop()
  release.resolve(false)
  await publishing
  await service.inactive(3)
  expect(listener).not.toHaveBeenCalled()
  expect(presence.cookie).toHaveBeenCalledTimes(1)
})

it('recovers the latest publication after a failed credential read', async () => {
  const service = new PublicationService()
  const listener = vi.fn()
  service.onStateChange(listener)
  presence.cookie.mockRejectedValueOnce(new Error('read failed'))
  await expect(service.inactive(1)).rejects.toThrow('read failed')
  await service.inactive(2)
  expect(listener).toHaveBeenLastCalledWith(
    expect.objectContaining({
      inactiveCodexAccounts: [
        expect.objectContaining({
          accountId: 'inactive',
          rateLimits: expect.objectContaining({
            session: expect.objectContaining({ usedPercent: 2 })
          })
        })
      ]
    })
  )
})
