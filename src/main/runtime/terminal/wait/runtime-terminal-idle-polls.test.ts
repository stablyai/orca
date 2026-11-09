import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './terminal-idle-polls'
import type { TerminalWaiter } from './terminal-waiter'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../../shared/agent-launch/catalog/tui-agent-config'

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

function makeWaiter(handle: string): TerminalWaiter {
  return {
    handle,
    ptyId: `${handle}-pty`,
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
      quiescenceMs: 1500,
      getForegroundProcess: () => null,
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: (waiter, result) => resolved.push({ handle: waiter.handle, result })
    })

    const waiters = Array.from({ length: 20 }, (_, index) => {
      const waiter = makeWaiter(`handle-${index}`)
      // Already idle: an independent interval would have resolved this on its own
      // first tick at exactly intervalMs, and so must the shared sweep.
      polls.start(waiter, makePty(`pty-${index}`, { lastAgentStatus: 'idle' }))
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

  it('retires the shared timer when the last waiter is cancelled through the waiter record', () => {
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getForegroundProcess: () => null,
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: () => {}
    })
    const first = makeWaiter('a')
    const second = makeWaiter('b')
    polls.start(first, makePty('pty-a'))
    polls.start(second, makePty('pty-b'))

    first.cancelIdlePoll?.()
    expect(first.cancelIdlePoll).toBeNull()
    expect(polls.activeTimerCount).toBe(1)

    second.cancelIdlePoll?.()
    expect(polls.activeTimerCount).toBe(0)
  })

  it('runs the foreground read per waiter without one waiter blocking another', async () => {
    const resolved: string[] = []
    const gates: ((value: string | null) => void)[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getForegroundProcess: () =>
        new Promise<string | null>((resolve) => {
          gates.push(resolve)
        }),
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: (waiter) => resolved.push(waiter.handle)
    })

    polls.start(makeWaiter('slow'), makePty('pty-slow', { lastOutputAt: Date.now() - 10_000 }))
    polls.start(makeWaiter('fast'), makePty('pty-fast', { lastOutputAt: Date.now() - 10_000 }))

    vi.advanceTimersByTime(INTERVAL_MS)
    // Same-sweep reads must overlap; unresolved first read cannot block the second.
    expect(gates).toHaveLength(2)

    gates[1]('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast'])

    gates[0]('node')
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual(['fast', 'slow'])
    expect(polls.activeTimerCount).toBe(0)
  })
})

describe('RuntimeTerminalIdlePolls rendered-screen blocked prompts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const TRUST_SCREEN = [
    'Accessing workspace:',
    '/repo/app',
    'Quick safety check: Is this a project you created or one you trust?',
    '❯ No, exit',
    '  Yes, I trust this folder',
    'Enter to confirm · Esc to cancel'
  ].join('\n')

  function createPolls(
    readVisibleScreen: (ptyId: string) => Promise<string | null> | null,
    resolved: RuntimeTerminalWait[],
    foreground: string | null = 'claude',
    agent: TuiAgent | null = null
  ): RuntimeTerminalIdlePolls {
    return new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      // Unknown agent + quiet pane: without the screen check this would settle idle.
      getForegroundProcess: () => (foreground ? Promise.resolve(foreground) : null),
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => agent,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen,
      resolve: (_waiter, result) => resolved.push(result)
    })
  }

  it('does not resolve a waiter that was cancelled while its screen read was pending', async () => {
    const resolved: RuntimeTerminalWait[] = []
    const finishRead = new Map<string, (screen: string) => void>()
    const reads: string[] = []
    const polls = createPolls(
      (ptyId) => {
        reads.push(ptyId)
        return new Promise<string>((resolve) => {
          finishRead.set(ptyId, resolve)
        })
      },
      resolved,
      null
    )
    const waiter = makeWaiter('pty')
    polls.start(waiter, makePty('pty-1'))
    polls.start(makeWaiter('other'), makePty('pty-2'))

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    // One read per waiter: the second sweep must not stack reads behind a pending one.
    expect(reads).toEqual(['pty-1', 'pty-2'])

    waiter.cancelIdlePoll?.()
    finishRead.get('pty-1')?.(TRUST_SCREEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([])
  })
})

describe('RuntimeTerminalIdlePolls quiet foreground for a launched agent', () => {
  const QUIESCENCE_MS = 1500

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function createPolls(
    agent: TuiAgent,
    resolved: string[],
    foregroundReads: string[] = []
  ): RuntimeTerminalIdlePolls {
    return new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: QUIESCENCE_MS,
      getForegroundProcess: (ptyId) => {
        foregroundReads.push(ptyId)
        return Promise.resolve(TUI_AGENT_CONFIG[agent].expectedProcess)
      },
      hasCommandPainted: () => true,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => agent,
      getFirstPartyAgentStatus: () => null,
      readScreenLines: () => null,
      readVisibleScreen: () => null,
      resolve: (waiter) => resolved.push(waiter.handle)
    })
  }

  // Amp titles never classify; disabling this lane for launches caused 60s worker readiness failure (STA-7440).
  it('settles an agent with no other rest signal once it has painted and gone quiet', async () => {
    const resolved: string[] = []
    const foregroundReads: string[] = []
    const polls = createPolls('amp', resolved, foregroundReads)
    const pty = makePty('pty-amp')
    polls.start(makeWaiter('pty'), pty)

    // Booting: the agent owns the foreground but has painted nothing (#9976).
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5)
    expect(resolved).toEqual([])

    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 2)
    pty.lastOutputAt = Date.now()
    // The next sweep lands inside the quiet window measured from that paint.
    await vi.advanceTimersByTimeAsync(INTERVAL_MS / 2)
    expect(resolved).toEqual([])
    // A pane that cannot settle yet costs no process inspection.
    expect(foregroundReads).toEqual([])

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(resolved).toEqual(['pty'])
    expect(polls.activeTimerCount).toBe(0)
  })
})
