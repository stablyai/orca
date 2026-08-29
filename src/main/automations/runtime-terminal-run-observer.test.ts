import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import type { AutomationRunTerminalHost } from './runtime-terminal-run-observer'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'

const HANDLE = 'terminal-1'
const RUNTIME_TUI_IDLE_TIMEOUT_MS = 5 * 60 * 1000
const AGENT_START_PROBE_SETTLE_MS = 300

/** The three shapes the runtime satisfies tui-idle from. `lastAgentStatus` is the
 *  sticky pty record, `paneTitle` the leaf branch's inlined title read, `preview`
 *  the ready-shell-prompt match. All three are level, none require an edge. */
type FakePane = {
  lastAgentStatus: 'idle' | 'working' | 'permission' | null
  paneTitle: string | null
  preview: string
}

type FakeWaiter = {
  resolve: (value: { satisfied: boolean; blockedReason?: string }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  agentTurnStartedAfter: number | null
}

function createFakeRuntime(initial: Partial<FakePane>) {
  const pane: FakePane = {
    lastAgentStatus: null,
    paneTitle: null,
    preview: '',
    ...initial
  }
  let lastWorkingAt = pane.lastAgentStatus === 'working' ? Date.now() : null
  let lastIdleAt = pane.lastAgentStatus === 'idle' ? Date.now() : null
  let lifecycleStatus = pane.lastAgentStatus
  const waiters = new Set<FakeWaiter>()
  let waitCalls = 0

  // Mirrors the runtime's tui-idle satisfaction: sticky status, idle title, or a
  // ready shell prompt — whichever is true at the instant of the read.
  const satisfiedNow = (): boolean =>
    pane.lastAgentStatus === 'idle' ||
    (pane.paneTitle?.toLowerCase().includes('idle') ?? false) ||
    pane.preview.trimEnd().endsWith('$')

  const completedTurnSince = (observedAfter: number | null): boolean =>
    observedAfter === null ||
    (lastWorkingAt !== null &&
      lastWorkingAt >= observedAfter &&
      lifecycleStatus === 'idle' &&
      lastIdleAt !== null &&
      lastIdleAt >= lastWorkingAt)

  const resolveSatisfiedWaiters = (): void => {
    if (!satisfiedNow()) {
      return
    }
    for (const waiter of waiters) {
      if (!completedTurnSince(waiter.agentTurnStartedAfter)) {
        continue
      }
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve({ satisfied: true })
    }
  }

  const runtime: AutomationRunTerminalHost & {
    setPane: (next: Partial<FakePane>) => void
    setAgentLifecycleStatus: (status: 'idle' | 'working') => void
    waitCalls: () => number
  } = {
    getTerminalHandleForPaneKey: () => HANDLE,
    hasTerminalAgentWorkedSince: (_handle, observedAfter) =>
      lastWorkingAt !== null && lastWorkingAt >= observedAfter,
    readTerminal: async () => ({ tail: ['previous run output'] }),
    waitForTerminal: (_handle, options) => {
      waitCalls += 1
      if (options?.signal?.aborted) {
        return Promise.reject(new Error('request_aborted'))
      }
      const agentTurnStartedAfter = options?.agentTurnStartedAfter ?? null
      if (satisfiedNow() && completedTurnSince(agentTurnStartedAfter)) {
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((resolve, reject) => {
        const waiter: FakeWaiter = {
          resolve,
          reject,
          agentTurnStartedAfter,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('timeout'))
          }, options?.timeoutMs ?? RUNTIME_TUI_IDLE_TIMEOUT_MS)
        }
        waiters.add(waiter)
      })
    },
    setPane: (next) => {
      const wasWorking =
        pane.lastAgentStatus === 'working' ||
        (pane.paneTitle?.toLowerCase().includes('working') ?? false)
      Object.assign(pane, next)
      const isWorking =
        pane.lastAgentStatus === 'working' ||
        (pane.paneTitle?.toLowerCase().includes('working') ?? false)
      const isIdle =
        pane.lastAgentStatus === 'idle' || (pane.paneTitle?.toLowerCase().includes('idle') ?? false)
      if (isWorking && !wasWorking) {
        lastWorkingAt = Date.now()
        lifecycleStatus = 'working'
      }
      if (!isWorking && wasWorking && isIdle) {
        lastIdleAt = Date.now()
        lifecycleStatus = 'idle'
      }
      resolveSatisfiedWaiters()
    },
    setAgentLifecycleStatus: (status) => {
      if (status === 'working' && lifecycleStatus !== 'working') {
        lastWorkingAt = Date.now()
      } else if (status === 'idle' && lifecycleStatus !== 'idle') {
        lastIdleAt = Date.now()
      }
      lifecycleStatus = status
      resolveSatisfiedWaiters()
    },
    waitCalls: () => waitCalls
  }
  return runtime
}

function observe(runtime: AutomationRunTerminalHost) {
  const controller = new AbortController()
  const settled: AutomationRunCompletionObservation[] = []
  const errors: unknown[] = []
  const observer = createRuntimeAutomationRunTerminalObserver(runtime)
  const promise = observer
    .observeCompletion(HANDLE, { signal: controller.signal, observedAfter: Date.now() })
    .then((observation) => {
      settled.push(observation)
    })
    .catch((error: unknown) => {
      errors.push(error)
    })
  return { controller, settled, errors, promise }
}

describe('createRuntimeAutomationRunTerminalObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not complete a reused run from the previous run idle status', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])
    expect(run.errors).toEqual([])

    runtime.setPane({ lastAgentStatus: 'working' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('does not complete from a stale idle pane title (leaf branch shape)', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: null, paneTitle: '✳ Claude — idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ paneTitle: '✳ Claude — working' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ paneTitle: '✳ Claude — idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('does not complete from a ready shell prompt left over at dispatch', async () => {
    const runtime = createFakeRuntime({ preview: 'user@host repo %\n$' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'working', preview: 'claude is thinking…' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('fails the run truthfully when the pane never leaves its pre-dispatch state', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1_000)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    expect(run.settled[0]?.error).toContain('never started')
    await run.promise
  })

  it('completes a fresh launch that was never idle at dispatch', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(10)
    expect(run.settled[0]?.status).toBe('completed')
    expect(run.settled[0]?.outputSnapshot?.content).toContain('previous run output')
    await run.promise
  })

  it('orders fresh terminal completion after the agent starts, works, and finishes', async () => {
    const runtime = createFakeRuntime({})
    const controller = new AbortController()
    const order: string[] = []
    const observer = createRuntimeAutomationRunTerminalObserver(runtime)
    const completion = observer
      .observeCompletion(HANDLE, { signal: controller.signal, observedAfter: Date.now() })
      .then((observation) => {
        order.push('completion-persisted')
        return observation
      })

    await vi.advanceTimersByTimeAsync(AGENT_START_PROBE_SETTLE_MS)
    runtime.setPane({ preview: 'user@host repo %\n$' })
    order.push('fresh-terminal-idle')
    await vi.advanceTimersByTimeAsync(1_000)

    // The explicit Codex hook can prove the turn started while the PTY still
    // retains a ready prompt or idle status from startup.
    runtime.setAgentLifecycleStatus('working')
    order.push('agent-started')
    await vi.advanceTimersByTimeAsync(1_000)

    runtime.setPane({ lastAgentStatus: 'working', paneTitle: 'Codex — working', preview: '' })
    order.push('agent-working')
    await vi.advanceTimersByTimeAsync(1_000)

    runtime.setAgentLifecycleStatus('idle')
    runtime.setPane({ lastAgentStatus: 'idle', paneTitle: 'Codex ready' })
    order.push('agent-finished')
    await vi.advanceTimersByTimeAsync(1_000)

    expect((await completion).status).toBe('completed')
    expect(order).toEqual([
      'fresh-terminal-idle',
      'agent-started',
      'agent-working',
      'agent-finished',
      'completion-persisted'
    ])
  })

  it('does not complete from stale idle evidence when working begins in the same millisecond', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    const run = observe(runtime)

    runtime.setAgentLifecycleStatus('working')
    await vi.advanceTimersByTimeAsync(AGENT_START_PROBE_SETTLE_MS)
    expect(run.settled).toEqual([])

    runtime.setAgentLifecycleStatus('idle')
    await vi.advanceTimersByTimeAsync(AGENT_START_PROBE_SETTLE_MS)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('propagates a thrown (non-timeout) wait error instead of inventing an outcome', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const disconnected: AutomationRunTerminalHost = {
      ...runtime,
      waitForTerminal: () => Promise.reject(new Error('terminal_gone'))
    }
    const run = observe(disconnected)

    await run.promise
    // Loss of contact is not evidence of completion or failure; the watcher owns
    // the truthful "stopped watching" close.
    expect(run.settled).toEqual([])
    expect(run.errors).toHaveLength(1)
    expect((run.errors[0] as Error).message).toBe('terminal_gone')
  })

  it('propagates a hasTerminalAgentWorkedSince throw instead of claiming the agent never started', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const disconnected: AutomationRunTerminalHost = {
      ...runtime,
      hasTerminalAgentWorkedSince: () => {
        throw new Error('terminal_gone')
      }
    }
    const run = observe(disconnected)

    // The start deadline expires while the terminal is unreachable. A terminal
    // that cannot be asked must not be read as "no work since" — that would turn
    // an SSH disconnect into a dispatch_failed('never started') fact.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1_000)
    await run.promise
    expect(run.settled).toEqual([])
    expect(run.errors).toHaveLength(1)
    expect((run.errors[0] as Error).message).toBe('terminal_gone')
  })

  it('propagates a disconnect from a re-armed ordered wait instead of completing', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    let waitCalls = 0
    const disconnecting: AutomationRunTerminalHost = {
      ...runtime,
      // The agent verifiably worked, then the terminal drops mid-wait: the first
      // wait expires on its own schedule, the re-armed wait hits the dead PTY.
      waitForTerminal: () => {
        waitCalls += 1
        return Promise.reject(new Error(waitCalls === 1 ? 'timeout' : 'terminal_gone'))
      }
    }
    const run = observe(disconnecting)

    await run.promise
    expect(run.settled).toEqual([])
    expect(run.errors).toHaveLength(1)
    expect((run.errors[0] as Error).message).toBe('terminal_gone')
  })

  it('stops re-arming the tui-idle wait instead of looping for the process lifetime', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + RUNTIME_TUI_IDLE_TIMEOUT_MS)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    expect(run.settled[0]?.error).toContain('without a completion signal')
    // 6h of 5-minute waits, not an unbounded re-arm.
    expect(runtime.waitCalls()).toBeLessThanOrEqual(80)
    await run.promise
  })
})
