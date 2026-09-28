import { describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))

const requestRefresh = vi.fn().mockResolvedValue(undefined)
vi.mock('../kiro-usage/kiro-usage-refresh-registry', () => ({
  getKiroUsageRefresh: () => ({ requestRefresh })
}))

import { registerKiroUsageHandlers } from './kiro-usage'
import type { RateLimitService } from '../rate-limits/service'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers pass the service straight through to the mocked refresh registry; nothing on it is read here.
const service = {} as RateLimitService

describe('registerKiroUsageHandlers', () => {
  it('starts a background refresh and awaits only the settle', async () => {
    registerKiroUsageHandlers(service)
    const handler = handlers.get('kiroUsage:refresh')
    expect(handler).toBeDefined()

    await expect(handler?.({}, true)).resolves.toBeUndefined()
    expect(requestRefresh).toHaveBeenCalledWith({ force: true })

    await handler?.({})
    expect(requestRefresh).toHaveBeenLastCalledWith({ force: false })
  })
})
