import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'

const INTERVAL_MS = 2000

function makePty(ptyId: string, overrides: Partial<RuntimePtyWorktreeRecord> = {}) {
  return {
    ptyId,
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOutputAt: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimePtyWorktreeRecord
}

function makeLeaf(tabId: string, overrides: Partial<RuntimeLeafRecord> = {}) {
  return {
    tabId,
    ptyId: `${tabId}-pty`,
    connected: true,
    lastExitCode: null,
    lastExitCause: null,
    lastAgentStatus: null,
    lastOutputAt: null,
    paneTitle: null,
    tailBuffer: [],
    tailPartialLine: '',
    preview: '',
    ...overrides
  } as unknown as RuntimeLeafRecord
}

function makeWaiter(handle: string): TerminalWaiter {
  return {
    handle,
    processIncarnation: null,
    condition: 'tui-idle',
    resolve: () => {},
    reject: () => {},
    timeout: null,
    cancelIdlePoll: null,
    abortCleanup: null
  }
}

describe('RuntimeTerminalIdlePolls timer budget', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
  })

  afterEach(() => {
    setIntervalSpy.mockRestore()
    vi.useRealTimers()
  })

  it('allocates one interval for 20 concurrent waiters and still resolves them on the first tick', () => {
    const resolved: { handle: string; result: RuntimeTerminalWait }[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      getTabTitle: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: (waiter, result) => resolved.push({ handle: waiter.handle, result })
    })

    const waiters = Array.from({ length: 20 }, (_, index) => {
      const waiter = makeWaiter(`handle-${index}`)
      // Already idle: an independent interval would have resolved this on its own
      // first tick at exactly intervalMs, and so must the shared sweep.
      polls.startPty(
        waiter,
        makePty(`pty-${index}`, { lastAgentStatus: 'idle', lastOscTitle: 'Codex ready' })
      )
      return waiter
    })

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(polls.activeTimerCount).toBe(1)
    expect(resolved).toHaveLength(0)

    vi.advanceTimersByTime(INTERVAL_MS - 1)
    expect(resolved).toHaveLength(0)

    vi.advanceTimersByTime(1)
    expect(resolved.map((entry) => entry.handle)).toEqual(waiters.map((waiter) => waiter.handle))
    // Every waiter retired, so the shared timer must retire with them.
    expect(polls.activeTimerCount).toBe(0)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps one interval across mixed leaf and pty waiters and re-arms after going idle', () => {
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      getTabTitle: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: () => {}
    })

    for (let index = 0; index < 10; index += 1) {
      polls.startPty(makeWaiter(`pty-handle-${index}`), makePty(`pty-${index}`))
      polls.startLeaf(makeWaiter(`leaf-handle-${index}`), makeLeaf(`tab-${index}`))
    }
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(INTERVAL_MS * 5)
    // Nothing resolved: still exactly one live handle after 5 sweeps.
    expect(polls.activeTimerCount).toBe(1)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
  })

  it('retires the shared timer when the last waiter is cancelled through the waiter record', () => {
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      getTabTitle: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: () => {}
    })
    const first = makeWaiter('a')
    const second = makeWaiter('b')
    polls.startPty(first, makePty('pty-a'))
    polls.startPty(second, makePty('pty-b'))

    first.cancelIdlePoll?.()
    expect(first.cancelIdlePoll).toBeNull()
    expect(polls.activeTimerCount).toBe(1)

    second.cancelIdlePoll?.()
    expect(polls.activeTimerCount).toBe(0)
  })

  it('does not infer readiness from a quiet foreground process', async () => {
    const resolved: string[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      getTabTitle: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: (waiter) => resolved.push(waiter.handle)
    })

    polls.startPty(makeWaiter('quiet'), makePty('pty-quiet', { lastOutputAt: Date.now() - 10_000 }))

    vi.advanceTimersByTime(INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([])
    expect(polls.activeTimerCount).toBe(1)
  })
})
