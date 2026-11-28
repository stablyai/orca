import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallerOwnedSignInChannel } from './caller-owned-sign-in-contract'
import { CallerOwnedSignInFlows } from './caller-owned-sign-in-flows'

type Prompt = { url: string }

function flowsWithDeadline(
  run: (channel: CallerOwnedSignInChannel<Prompt, string>) => Promise<object>
): CallerOwnedSignInFlows<'claude', Prompt, string, object> {
  return new CallerOwnedSignInFlows<'claude', Prompt, string, object>(
    (_provider, channel) => run(channel),
    {
      acceptsPrompt: () => true,
      acceptsCode: () => true,
      describeFailure: (error) => ({ error }),
      busyMessage: 'busy',
      ownerSilenceMs: 10_000_000,
      promptDeadlineMs: 60_000
    }
  )
}

// Aborted like a real login: the run rejects once the flow ends it.
function runUntilAborted(channel: CallerOwnedSignInChannel<Prompt, string>): Promise<object> {
  return new Promise((_, reject) =>
    channel.signal.addEventListener('abort', () => reject(new Error('cancelled')))
  )
}

describe('CallerOwnedSignInFlows prompt deadline', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fails a login that never publishes a prompt, with a code clients can name', async () => {
    const flows = flowsWithDeadline(runUntilAborted)
    const started = flows.start('owner', 'claude')
    await vi.advanceTimersByTimeAsync(60_000)
    const status = await flows.wait('owner', started.flowId, 0)
    expect(status.phase).toBe('failed')
    expect(status.errorCode).toBe('noPrompt')
  })

  it('leaves a login that prompted in time waiting for the code', async () => {
    const flows = flowsWithDeadline((channel) => {
      channel.onPrompt({ url: 'https://claude.ai/oauth/authorize?x' })
      return runUntilAborted(channel)
    })
    const started = flows.start('owner', 'claude')
    await vi.advanceTimersByTimeAsync(120_000)
    const status = await flows.wait('owner', started.flowId, 0)
    expect(status.phase).toBe('waiting')
  })
})

describe('CallerOwnedSignInFlows owner take-over', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function flowsWithTakeOver(): CallerOwnedSignInFlows<'claude', Prompt, string, object, string> {
    return new CallerOwnedSignInFlows<'claude', Prompt, string, object, string>(
      (_provider, channel) => runUntilAborted(channel),
      {
        acceptsPrompt: () => true,
        acceptsCode: () => true,
        describeFailure: (error) => ({ error }),
        busyMessage: 'busy',
        startKey: (accountId) => accountId,
        ownerSilenceMs: 600_000,
        ownerTakesOverAfterMs: 60_000
      }
    )
  }

  it('lets an owner that stopped asking replace its own flow, but never another owner or a live one', async () => {
    const flows = flowsWithTakeOver()
    const lost = flows.start('phone', 'claude', 'account-a')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(() => flows.start('phone', 'claude', 'account-b')).toThrow('busy')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(() => flows.start('desktop', 'claude', 'account-b')).toThrow('busy')

    const replacement = flows.start('phone', 'claude', 'account-b')
    expect(replacement.flowId).not.toBe(lost.flowId)
    await vi.advanceTimersByTimeAsync(0)
    expect(flows.activeFlow()).toEqual({ owner: 'phone', flowId: replacement.flowId })
  })
})
