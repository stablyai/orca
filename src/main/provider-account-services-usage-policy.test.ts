import { expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../shared/constants'
import { deferred } from './rate-limits/rate-limit-service-test-harness'
import type { CodexHomePathResolver } from './rate-limits/service/service-types'

const fakes = vi.hoisted(() => ({
  running: vi.fn<() => Promise<boolean>>(),
  prepare: vi.fn(() => ({ kind: 'ready' as const, codexHomePath: '/saved' }))
}))
vi.mock('./persistence', () => ({
  Store: class {
    getSettings = () => getDefaultSettings('/tmp')
    getUI = () => ({ statusBarItems: [] })
    onSettingsChanged = () => {}
    onUIChanged = () => {}
  }
}))
vi.mock('./codex-accounts/runtime-home-service', () => ({
  CodexRuntimeHomeService: class {
    prepareForRateLimitFetch = fakes.prepare
  }
}))
vi.mock('./codex-accounts/service', () => ({ CodexAccountService: class {} }))
vi.mock('./claude-accounts/service', () => ({ ClaudeAccountService: class {} }))
vi.mock('./claude-accounts/runtime-auth-service', () => ({
  ClaudeRuntimeAuthService: class {
    readUsageAttribution = async () => null
  }
}))
vi.mock('./wsl-background-distro-gate', () => ({
  isWslDistroRunningForBackgroundWork: fakes.running
}))

import { Store } from './persistence'
import { RateLimitService } from './rate-limits/service'
import { createProviderAccountServices } from './provider-account-services'

it('does not prepare Codex credentials after cancellation during the factory running-distro check', async () => {
  let resolver: CodexHomePathResolver | undefined
  const capture = vi
    .spyOn(RateLimitService.prototype, 'setCodexHomePathResolver')
    .mockImplementation((next) => {
      resolver = next
    })
  try {
    createProviderAccountServices(new Store(), { setClaudeStatusLineListener: () => {} })
    expect(resolver).toBeDefined()
    const running = deferred<boolean>()
    fakes.running.mockReturnValueOnce(running.promise)
    const controller = new AbortController()
    const pending = resolver?.({ runtime: 'wsl', wslDistro: 'Ubuntu' }, controller.signal)
    expect(fakes.running).toHaveBeenCalledTimes(1)
    controller.abort()
    running.resolve(true)
    await expect(pending).resolves.toEqual({ kind: 'skip' })
    expect(fakes.prepare).not.toHaveBeenCalled()
  } finally {
    capture.mockRestore()
  }
})
