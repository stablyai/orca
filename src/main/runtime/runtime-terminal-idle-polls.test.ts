import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeTerminalIdlePolls } from './runtime-terminal-idle-polls'
import type { TerminalWaiter } from './runtime-terminal-contracts'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { RuntimeTerminalWait } from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'

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
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readVisibleScreen: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: (waiter, result) => resolved.push({ handle: waiter.handle, result })
    })

    const waiters = Array.from({ length: 20 }, (_, index) => {
      const waiter = makeWaiter(`handle-${index}`)
      // Already idle: an independent interval would have resolved this on its own
      // first tick at exactly intervalMs, and so must the shared sweep.
      polls.startPty(waiter, makePty(`pty-${index}`, { lastAgentStatus: 'idle' }))
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
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readVisibleScreen: () => null,
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
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () => null,
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readVisibleScreen: () => null,
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

  it('runs the foreground read per waiter without one waiter blocking another', async () => {
    const resolved: string[] = []
    const gates: ((value: string | null) => void)[] = []
    const polls = new RuntimeTerminalIdlePolls({
      intervalMs: INTERVAL_MS,
      quiescenceMs: 1500,
      getTabTitle: () => null,
      getForegroundProcess: () =>
        new Promise<string | null>((resolve) => {
          gates.push(resolve)
        }),
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => null,
      getFirstPartyAgentStatus: () => null,
      readVisibleScreen: () => null,
      getLiveLeaf: (leaf) => leaf,
      resolve: (waiter) => resolved.push(waiter.handle)
    })

    polls.startPty(makeWaiter('slow'), makePty('pty-slow', { lastOutputAt: Date.now() - 10_000 }))
    polls.startPty(makeWaiter('fast'), makePty('pty-fast', { lastOutputAt: Date.now() - 10_000 }))

    vi.advanceTimersByTime(INTERVAL_MS)
    // Both waiters issued their read in the same sweep — a sequential sweep would
    // have blocked the second behind the first's unresolved promise.
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
      getTabTitle: () => null,
      // Unknown agent + quiet pane: without the screen check this would settle idle.
      getForegroundProcess: () => (foreground ? Promise.resolve(foreground) : null),
      getAdoptedPtyIdleStatus: () => null,
      getPaneAgent: () => agent,
      getFirstPartyAgentStatus: () => null,
      readVisibleScreen,
      getLiveLeaf: (leaf) => leaf,
      resolve: (_waiter, result) => resolved.push(result)
    })
  }

  it('reports a dialog the tail lost but the screen still shows, ahead of a quiet-pane idle', async () => {
    const resolved: RuntimeTerminalWait[] = []
    const polls = createPolls(() => Promise.resolve(TRUST_SCREEN), resolved)
    polls.startPty(makeWaiter('pty'), makePty('pty-1', { lastOutputAt: Date.now() - 10_000 }))
    polls.startLeaf(makeWaiter('leaf'), makeLeaf('tab-1', { lastOutputAt: Date.now() - 10_000 }))

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(resolved).toHaveLength(2)
    expect(resolved).toEqual([
      expect.objectContaining({ satisfied: false, blockedReason: 'agent-trust-workspace' }),
      expect.objectContaining({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    ])
    expect(polls.activeTimerCount).toBe(0)
  })

  it('does not read the screen of an agent whose title says it is working', async () => {
    const resolved: RuntimeTerminalWait[] = []
    const reads: string[] = []
    const polls = createPolls((ptyId) => {
      reads.push(ptyId)
      return Promise.resolve(TRUST_SCREEN)
    }, resolved)
    polls.startPty(makeWaiter('pty'), makePty('pty-1', { lastAgentStatus: 'working' }))
    polls.startLeaf(makeWaiter('leaf'), makeLeaf('tab-1', { lastAgentStatus: 'working' }))

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(reads).toEqual([])
    expect(resolved).toEqual([])
    expect(polls.activeTimerCount).toBe(1)
  })

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
    polls.startPty(waiter, makePty('pty-1'))
    polls.startPty(makeWaiter('other'), makePty('pty-2'))

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    // One read per waiter: the second sweep must not stack reads behind a pending one.
    expect(reads).toEqual(['pty-1', 'pty-2'])

    waiter.cancelIdlePoll?.()
    finishRead.get('pty-1')?.(TRUST_SCREEN)
    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([])
  })

  // Why: a name-only title is the only rest signal these agents emit, but it cannot see a
  // dialog the tail lost, so it settles only once the screen read comes back clear.
  it.each(['grok', 'copilot', 'aider'] as const)(
    "settles %s's name-only title only after its screen read",
    async (agent) => {
      const resolved: RuntimeTerminalWait[] = []
      const screens: ((screen: string) => void)[] = []
      const polls = createPolls(
        () => new Promise<string>((resolve) => screens.push(resolve)),
        resolved,
        null,
        agent
      )
      const pty = makePty('pty-1', { lastAgentStatus: 'idle', lastOscTitle: agent })
      polls.startPty(makeWaiter('pty'), pty, { kind: 'ready-weak' })

      await vi.advanceTimersByTimeAsync(0)
      expect(screens).toHaveLength(1)
      expect(resolved).toEqual([])

      screens[0](`${agent} ready for input`)
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toEqual([expect.objectContaining({ satisfied: true })])
    }
  )

  it('reports a dialog on screen under a name-only title instead of settling ready', async () => {
    const resolved: RuntimeTerminalWait[] = []
    const polls = createPolls(() => Promise.resolve(TRUST_SCREEN), resolved, null, 'grok')
    const pty = makePty('pty-1', { lastAgentStatus: 'idle', lastOscTitle: 'grok' })
    polls.startPty(makeWaiter('pty'), pty, { kind: 'ready-weak' })

    await vi.advanceTimersByTimeAsync(0)
    expect(resolved).toEqual([
      expect.objectContaining({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    ])
  })

  it("lets an agent's own idle title outrank dialog wording on its screen", async () => {
    const resolved: RuntimeTerminalWait[] = []
    const reads: string[] = []
    const polls = createPolls(
      (ptyId) => {
        reads.push(ptyId)
        return Promise.resolve(TRUST_SCREEN)
      },
      resolved,
      null,
      'claude'
    )
    const pty = makePty('pty-1', { lastAgentStatus: 'idle', lastOscTitle: '✳ Claude Code' })
    polls.startPty(makeWaiter('pty'), pty)

    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reads).toEqual([])
    expect(resolved).toEqual([expect.objectContaining({ satisfied: true })])
  })
})
