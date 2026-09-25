import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import type { AutomationRunTerminalHost } from './runtime-terminal-run-observer'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'

const HANDLE = 'terminal-1'
const RUNTIME_TUI_IDLE_TIMEOUT_MS = 5 * 60 * 1000

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
}

function createFakeRuntime(initial: Partial<FakePane>) {
  const pane: FakePane = {
    lastAgentStatus: null,
    paneTitle: null,
    preview: '',
    ...initial
  }
  const waiters = new Set<FakeWaiter>()
  let waitCalls = 0

  // Mirrors the runtime's tui-idle satisfaction: sticky status, idle title, or a
  // ready shell prompt — whichever is true at the instant of the read.
  const satisfiedNow = (): boolean =>
    pane.lastAgentStatus === 'idle' ||
    (pane.paneTitle?.toLowerCase().includes('idle') ?? false) ||
    pane.preview.trimEnd().endsWith('$')

  const runtime: AutomationRunTerminalHost & {
    setPane: (next: Partial<FakePane>) => void
    waitCalls: () => number
  } = {
    getTerminalHandleForPaneKey: () => HANDLE,
    readTerminal: async () => ({ tail: ['previous run output'] }),
    waitForTerminal: (_handle, options) => {
      waitCalls += 1
      if (options?.signal?.aborted) {
        return Promise.reject(new Error('request_aborted'))
      }
      if (satisfiedNow()) {
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((resolve, reject) => {
        const waiter: FakeWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('timeout'))
          }, options?.timeoutMs ?? RUNTIME_TUI_IDLE_TIMEOUT_MS)
        }
        waiters.add(waiter)
      })
    },
    setPane: (next) => {
      Object.assign(pane, next)
      if (!satisfiedNow()) {
        return
      }
      for (const waiter of waiters) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve({ satisfied: true })
      }
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
    .observeCompletion(HANDLE, { signal: controller.signal })
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

    runtime.setPane({ preview: 'claude is thinking…' })
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
