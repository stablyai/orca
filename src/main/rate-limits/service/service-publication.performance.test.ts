import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
  inactive(value: number): void {
    this.inactiveCodexCache.set('inactive', okProvider('codex', value))
    this.pushToRenderer()
  }
}
const promiseThen = Promise.prototype.then
const promiseCatch = Promise.prototype.catch

// Vitest's promise-return tracking cannot spy on then without recursively observing itself.
function observePublication() {
  const registrations = new WeakMap<Promise<unknown>, number>()
  let flight: Promise<unknown> | undefined
  // oxlint-disable-next-line unicorn/no-thenable -- Instrument the native registration seam, not a new thenable.
  Object.defineProperty(Promise.prototype, 'then', {
    configurable: true,
    writable: true,
    value(this: Promise<unknown>, ...args: Parameters<typeof promiseThen>) {
      registrations.set(this, (registrations.get(this) ?? 0) + 1)
      return promiseThen.call(this, ...args)
    }
  })
  Object.defineProperty(Promise.prototype, 'catch', {
    configurable: true,
    writable: true,
    value(this: Promise<unknown>, ...args: Parameters<typeof promiseCatch>) {
      // oxlint-disable-next-line typescript/no-this-alias -- Retain the observed drain identity for handler counts.
      flight = this
      return promiseCatch.call(this, ...args)
    }
  })
  return {
    flight: () => {
      if (!flight) {
        throw new Error('No publication error handler registered')
      }
      return flight
    },
    handlers: (promise: Promise<unknown>) => registrations.get(promise) ?? 0
  }
}
afterEach(() => {
  // oxlint-disable-next-line unicorn/no-thenable -- Restore the instrumented native method.
  Promise.prototype.then = promiseThen
  Promise.prototype.catch = promiseCatch
  vi.restoreAllMocks()
})

beforeEach(() => {
  presence.cookie.mockReset().mockResolvedValue(false)
  presence.minimax.mockReset().mockResolvedValue(false)
  presence.zcode.mockReset().mockResolvedValue(false)
})

it('coalesces overlapping active and inactive publications before credential admission', async () => {
  const count = 1000
  const service = new PublicationService()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<boolean>()
  presence.cookie.mockImplementationOnce(() => {
    entered.resolve()
    return release.promise
  })
  const received: RateLimitState[] = []
  service.onStateChange((state) => received.push(state))
  const observer = observePublication()
  service.change(0)
  service.inactive(0)
  const publishing = observer.flight()
  await entered.promise
  for (let value = 1; value <= count; value++) {
    service.change(value)
    service.inactive(value)
  }
  expect(presence.cookie).toHaveBeenCalledTimes(1)
  expect(presence.minimax).toHaveBeenCalledTimes(1)
  expect(presence.zcode).toHaveBeenCalledTimes(1)
  release.resolve(false)
  await publishing
  expect(presence.cookie).toHaveBeenCalledTimes(2)
  expect(presence.minimax).toHaveBeenCalledTimes(2)
  expect(presence.zcode).toHaveBeenCalledTimes(2)
  expect(received).toHaveLength(2)
  expect(received[0].codex?.session?.usedPercent).toBe(count)
  expect(received[0].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(count)
  expect(received[1].codex?.session?.usedPercent).toBe(count)
  expect(received[1].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(count)
})

it('publishes progress during continuous updates', async () => {
  const count = 100
  const service = new PublicationService()
  const reads = Array.from({ length: count + 1 }, () => ({
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<boolean>()
  }))
  let nextRead = 0
  presence.cookie.mockImplementation(() => {
    const read = reads[nextRead++]
    read.entered.resolve()
    return read.release.promise
  })
  const received: RateLimitState[] = []
  service.onStateChange((state) => received.push(state))
  const observer = observePublication()
  service.change(0)
  service.inactive(0)
  const publishing = observer.flight()
  await reads[0].entered.promise
  for (let value = 1; value <= count; value++) {
    service.change(value)
    service.inactive(value)
    reads[value - 1].release.resolve(false)
    await reads[value].entered.promise
    expect(received).toHaveLength(value)
    expect(received[value - 1].codex?.session?.usedPercent).toBe(value)
    expect(received[value - 1].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(
      value
    )
  }
  expect(observer.handlers(publishing)).toBe(1)
  reads[count].release.resolve(false)
  await publishing
  expect(presence.cookie).toHaveBeenCalledTimes(count + 1)
  expect(presence.minimax).toHaveBeenCalledTimes(count + 1)
  expect(presence.zcode).toHaveBeenCalledTimes(count + 1)
  expect(received).toHaveLength(count + 1)
  expect(received[count].codex?.session?.usedPercent).toBe(count)
  expect(received[count].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(count)
  presence.cookie.mockResolvedValue(false)
  service.inactive(count + 1)
  const nextFlight = observer.flight()
  expect(nextFlight).not.toBe(publishing)
  await nextFlight
  expect(received).toHaveLength(count + 2)
  expect(received[count + 1].inactiveCodexAccounts[0].rateLimits?.session?.usedPercent).toBe(
    count + 1
  )
})

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
  const observer = observePublication()
  service.inactive(1)
  const publishing = observer.flight()
  await entered.promise
  service.change(2)
  service.stop()
  release.resolve(false)
  await publishing
  service.inactive(3)
  expect(observer.handlers(publishing)).toBe(1)
  expect(listener).not.toHaveBeenCalled()
  expect(presence.cookie).toHaveBeenCalledTimes(1)
})

it('recovers the latest publication after a failed credential read', async () => {
  const service = new PublicationService()
  const listener = vi.fn()
  service.onStateChange(listener)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const observer = observePublication()
  presence.cookie.mockRejectedValueOnce(new Error('read failed'))
  service.inactive(1)
  const failed = observer.flight()
  await expect(failed).rejects.toThrow('read failed')
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    '[rate-limits] Failed to publish usage state',
    expect.any(Error)
  )
  service.inactive(2)
  await observer.flight()
  expect(warning).toHaveBeenCalledTimes(1)
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
