import { describe, expect, it, vi } from 'vitest'
import { makePtyTerm } from './codex-fetcher-rpc-test-harness'

describe('Codex fetcher RPC test harness', () => {
  it('stops delivering PTY events after subscriptions are disposed', () => {
    const term = makePtyTerm()
    const dataHandler = vi.fn()
    const exitHandler = vi.fn()
    const dataSubscription = term.onData(dataHandler)
    const exitSubscription = term.onExit(exitHandler)

    dataSubscription.dispose()
    exitSubscription.dispose()
    term.emitData('late data')
    term.emitExit()

    expect(dataHandler).not.toHaveBeenCalled()
    expect(exitHandler).not.toHaveBeenCalled()
  })
})
