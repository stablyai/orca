import { afterEach, describe, expect, it, vi } from 'vitest'

import { runPluginHookChain } from '../../../shared/plugins/workers/plugin-hook-chain'

afterEach(() => {
  vi.useRealTimers()
})

describe('hook plugin warming', () => {
  it('bounds worker start by its own timeout, then gives the handler the full deadline', async () => {
    vi.useFakeTimers()
    const logs: string[] = []
    let started!: () => void
    let answer!: (decision: unknown) => void
    const outcome = runPluginHookChain({
      event: 'terminal.send',
      payload: { terminalId: 't', text: 'rm -rf /', enter: true, inputKind: 'driving' },
      participants: ['acme.slow-start'],
      start: () => new Promise<void>((resolve) => (started = resolve)),
      startTimeoutMs: 10_000,
      invoke: () => new Promise((resolve) => (answer = resolve)),
      deadlineMs: 2_000,
      log: (pluginKey, line) => void logs.push(`${pluginKey}: ${line}`),
      now: () => 0
    })
    // A start past the 2 s handler deadline, then a handler inside it: neither is skipped.
    await vi.advanceTimersByTimeAsync(5_000)
    started()
    await vi.advanceTimersByTimeAsync(1_500)
    answer({ decision: 'result', result: { deny: 'no' } })
    await expect(outcome).resolves.toEqual({
      kind: 'deny',
      pluginKey: 'acme.slow-start',
      reason: 'no'
    })
    expect(logs).toEqual([])
  })
})
