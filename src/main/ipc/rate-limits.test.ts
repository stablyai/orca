import { beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

import { registerRateLimitHandlers } from './rate-limits'
import type { RateLimitService } from '../rate-limits/service'
import type { RateLimitState } from '../../shared/rate-limit-types'

function makeService(): { service: RateLimitService; refresh: ReturnType<typeof vi.fn> } {
  const refresh = vi.fn(() => Promise.resolve({} as RateLimitState))
  const service = {
    getState: vi.fn(() => ({}) as RateLimitState),
    refresh,
    refreshCodexForTarget: vi.fn(() => Promise.resolve({} as RateLimitState)),
    refreshClaudeForTarget: vi.fn(() => Promise.resolve({} as RateLimitState)),
    consumeCodexRateLimitResetCredit: vi.fn(() =>
      Promise.resolve({ outcome: 'noCredit', state: {} as RateLimitState })
    ),
    setPollingInterval: vi.fn(() => Promise.resolve()),
    fetchInactiveClaudeAccountsOnOpen: vi.fn(() => Promise.resolve()),
    fetchInactiveCodexAccountsOnOpen: vi.fn(() => Promise.resolve())
  }
  return { service: service as unknown as RateLimitService, refresh }
}

describe('registerRateLimitHandlers', () => {
  beforeEach(() => {
    ipcState.handleHandlers.clear()
  })

  it('registers a refreshMiniMax channel that delegates to refresh()', async () => {
    const { service, refresh } = makeService()
    registerRateLimitHandlers(service)
    const handler = ipcState.handleHandlers.get('rateLimits:refreshMiniMax')
    expect(handler).toBeDefined()
    await handler!({})
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing rate-limit channels registered', () => {
    const { service } = makeService()
    registerRateLimitHandlers(service)
    expect(ipcState.handleHandlers.has('rateLimits:get')).toBe(true)
    expect(ipcState.handleHandlers.has('rateLimits:refresh')).toBe(true)
    expect(ipcState.handleHandlers.has('rateLimits:refreshMiniMax')).toBe(true)
  })
})
