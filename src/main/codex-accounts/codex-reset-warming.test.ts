import { describe, expect, it, vi } from 'vitest'
import type { CodexManagedAccount } from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  CodexResetWarming,
  type CodexWarmingState,
  type CodexResetWarmingDependencies
} from './codex-reset-warming'

const account = (id: string): CodexManagedAccount => ({
  id,
  email: `${id}@example.test`,
  managedHomePath: `/accounts/${id}`,
  createdAt: 1,
  updatedAt: 1,
  lastAuthenticatedAt: 1
})
function usage(now: number, reset: number, usedPercent = 0): ProviderRateLimits {
  const window = { usedPercent, resetsAt: reset, windowMinutes: 300, resetDescription: null }
  return {
    provider: 'codex',
    status: 'ok',
    error: null,
    session: window,
    weekly: window,
    updatedAt: now
  }
}
function fixture(initial: CodexWarmingState = {}) {
  let now = 100
  let enabled = true
  let accounts = [account('a'), account('b')]
  let saved: CodexWarmingState = initial
  const reads = vi.fn(async () => usage(now, now + 100))
  const save = vi.fn(async (state: CodexWarmingState) => {
    saved = structuredClone(state)
  })
  const warm = vi.fn<CodexResetWarmingDependencies['warm']>(
    async (_account, _signal, beforeSubmit) => {
      await beforeSubmit()
      return true
    }
  )
  const busy = vi.fn(() => false)
  const deps: CodexResetWarmingDependencies = {
    accounts: () => accounts,
    enabled: () => enabled,
    busy,
    readUsage: reads,
    warm,
    save,
    now: () => now
  }
  const engine = new CodexResetWarming(initial, deps)
  return {
    engine,
    deps,
    reads,
    save,
    warm,
    busy,
    saved: () => saved,
    time: (value: number) => {
      now = value
    },
    disable: () => {
      enabled = false
      engine.cancel()
    },
    remove: () => {
      accounts = []
      engine.cancel()
    }
  }
}

describe('durable reset warming', () => {
  it('warms each account independently and coalesces simultaneous windows', async () => {
    const f = fixture()
    await f.engine.tick()
    expect(f.warm).not.toHaveBeenCalled()
    f.time(201)
    await f.engine.tick()
    expect(f.warm.mock.calls.map(([value]) => value.id)).toEqual(['a', 'b'])
    expect(f.saved().a.attempted).toEqual({ session: 200, weekly: 200 })
    expect(f.saved().a.status).toBe('unconfirmed')
  })
  it('persists intent before submission and never repeats an ambiguous attempt after restart', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(201)
    f.warm.mockImplementation(async (value, _signal, beforeSubmit) => {
      await beforeSubmit()
      expect(f.saved()[value.id].status).toBe('attempting')
      throw new Error('transport lost after write')
    })
    await f.engine.tick()
    const restarted = new CodexResetWarming(f.saved(), f.deps)
    f.time(10_000)
    await restarted.tick()
    expect(f.warm).toHaveBeenCalledTimes(2)
  })
  it('holds the original deadline when unused reset estimates slide forward', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(150)
    await f.engine.tick()
    expect(f.saved().a.deadlines.session).toBe(200)
    f.time(201)
    await f.engine.tick()
    expect(f.warm).toHaveBeenCalledTimes(2)
  })
  it('processes overdue saved deadlines after sleep or restart', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(10_000)
    await new CodexResetWarming(f.saved(), f.deps).tick()
    expect(f.warm).toHaveBeenCalledTimes(2)
  })
  it('defers when another window remains exhausted, or foreground work owns the account', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(201)
    f.reads.mockImplementation(async () => usage(201, 500, 100))
    await f.engine.tick()
    expect(f.warm).not.toHaveBeenCalled()
    f.reads.mockImplementation(async () => usage(201, 500))
    f.busy.mockReturnValue(true)
    await f.engine.tick()
    expect(f.warm).not.toHaveBeenCalled()
    f.busy.mockReturnValue(false)
    await f.engine.tick()
    expect(f.warm).toHaveBeenCalledTimes(2)
  })
  it('does not submit when persistence fails', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(201)
    f.save.mockRejectedValue(new Error('disk full'))
    const submitted = vi.fn()
    f.warm.mockImplementation(async (_account, _signal, beforeSubmit) => {
      await beforeSubmit()
      submitted()
      return true
    })
    await expect(f.engine.tick()).rejects.toThrow('disk full')
    expect(submitted).not.toHaveBeenCalled()
  })
  it.each(['disable', 'remove', 'stop'] as const)(
    'fences %s during a quota read',
    async (action) => {
      const f = fixture()
      await f.engine.tick()
      f.time(201)
      f.reads.mockImplementation(async () => {
        if (action === 'stop') {
          f.engine.stop()
        } else {
          f[action]()
        }
        return usage(201, 500)
      })
      await f.engine.tick()
      expect(f.warm).not.toHaveBeenCalled()
    }
  )
  it('serializes concurrent wakeups and only verifies observed nonzero new windows', async () => {
    const f = fixture()
    await f.engine.tick()
    f.time(201)
    let reads = 0
    f.reads.mockImplementation(async () => usage(201, 500, reads++ % 2))
    await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()])
    expect(f.warm).toHaveBeenCalledTimes(2)
    expect(f.saved().a.status).toBe('verified')
  })
})
