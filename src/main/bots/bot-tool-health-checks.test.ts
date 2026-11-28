import { describe, expect, it, vi } from 'vitest'
import {
  botToolHealthCheckKey,
  cancelBotToolHealthChecks,
  sharedBotToolHealthCheck
} from './bot-tool-health-checks'

describe('sharedBotToolHealthCheck', () => {
  it('shares a check only among requests under the same settings', async () => {
    const before = Promise.withResolvers<Record<string, never>>()
    const after = Promise.withResolvers<Record<string, never>>()
    const runs = vi.fn()
    const run = (answer: Promise<Record<string, never>>) => async () => {
      runs()
      return await answer
    }
    // A client under the old Arguments, then one under the new, then one after a rollback.
    const old = sharedBotToolHealthCheck(
      'bot',
      botToolHealthCheckKey('codex', false, 'a'),
      run(before.promise)
    )
    const fresh = sharedBotToolHealthCheck(
      'bot',
      botToolHealthCheckKey('codex', false, 'b'),
      run(after.promise)
    )
    const rolledBack = sharedBotToolHealthCheck(
      'bot',
      botToolHealthCheckKey('codex', false, 'a'),
      run(Promise.resolve({}))
    )
    expect(runs).toHaveBeenCalledTimes(2)
    expect(rolledBack).toBe(old)
    // The newer check answering first doesn't settle the older one.
    after.resolve({})
    await fresh
    before.resolve({})
    await old
    cancelBotToolHealthChecks('bot')
  })

  it('keeps scopes and agents apart', () => {
    expect(botToolHealthCheckKey('codex', true, 'a')).not.toBe(
      botToolHealthCheckKey('codex', false, 'a')
    )
    expect(botToolHealthCheckKey('claude', false, undefined)).not.toBe(
      botToolHealthCheckKey('codex', false, undefined)
    )
  })
})
