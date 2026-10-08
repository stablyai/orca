import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../shared/automations-types'
import { AGENT_START_GRACE_MS } from './automation-run-agent-evidence'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const HANDLE = 'terminal-1'
const PANE_KEY = 'tab-1:pane-1'
const RUNTIME_TUI_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** A pane where idle is idle whatever painted it: a ready shell prompt satisfies tui-idle too. */
function createPane(initial: { idle: boolean; tail: string[]; idleEdgeOnly?: boolean }) {
  let idle = initial.idle
  // The real runtime may settle tui-idle once per idle edge: an already-idle shell only times out.
  let edgeSpent = false
  let tail = initial.tail
  let rows: { receivedAt: number }[] = []
  const waiters = new Set<() => void>()
  const runtime: AutomationRunTerminalHost = {
    getTerminalHandleForPaneKey: () => HANDLE,
    readTerminal: async () => ({ tail }),
    waitForTerminal: (_handle, options) => {
      if (options?.signal?.aborted) {
        return Promise.reject(new Error('request_aborted'))
      }
      if (idle && !(initial.idleEdgeOnly && edgeSpent)) {
        edgeSpent = true
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(wake)
          reject(new Error('timeout'))
        }, options?.timeoutMs ?? RUNTIME_TUI_IDLE_TIMEOUT_MS)
        const wake = (): void => {
          clearTimeout(timer)
          resolve({ satisfied: true })
        }
        waiters.add(wake)
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          waiters.delete(wake)
          reject(new Error('request_aborted'))
        })
      })
    }
  }
  return {
    runtime,
    agentRows: () => rows,
    report: (receivedAt = Date.now()) => (rows = [{ receivedAt }]),
    setTail: (next: string[]) => (tail = next),
    becomeIdle: () => {
      idle = true
      for (const wake of waiters) {
        waiters.delete(wake)
        wake()
      }
    }
  }
}

function observe(pane: ReturnType<typeof createPane>, controller = new AbortController()) {
  const observer = createRuntimeAutomationRunTerminalObserver(pane.runtime, {
    getAgentStatusRowsForPane: (paneKey) => (paneKey === PANE_KEY ? pane.agentRows() : []),
    agentCommandsForRun: () => ['goose']
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only these run fields.
  const run = {
    terminalPaneKey: PANE_KEY,
    startedAt: Date.now(),
    dispatchedAt: null
  } as AutomationRun
  const settled = vi.fn()
  const failed = vi.fn()
  const promise = observer
    .observeCompletion(HANDLE, { signal: controller.signal, run })
    .then(settled, failed)
  return { settled, failed, promise, controller }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('observing a run with agent evidence', () => {
  it.each([
    ['bash', 'bash: goose: command not found'],
    ['zsh', 'zsh: command not found: goose'],
    ['dash', 'sh: 1: goose: not found'],
    ['fish', 'fish: Unknown command: goose'],
    ['PowerShell', "goose: The term 'goose' is not recognized as the name of a cmdlet"]
  ])('fails, never completes, a run whose agent %s cannot find', async (_shell, refusal) => {
    const run = observe(createPane({ idle: true, tail: ['$ goose run', refusal, '$'] }))
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        error: expect.stringContaining(refusal)
      })
    )
  })

  it('completes once the agent itself reported for the run pane', async () => {
    const pane = createPane({ idle: false, tail: ['working'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(1_000)
    pane.report()
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('keeps idle-means-done for an agent that never reports, after its start window', async () => {
    const pane = createPane({ idle: true, tail: ['summary written', '$'] })
    pane.report(1)
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it("never reads an agent's own tool output as its command missing", async () => {
    const tail = ['running tests', 'bash: pytest: command not found', 'fell back to unittest', '$']
    const run = observe(createPane({ idle: true, tail }))
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('completes an agent that exited before the window once the window passes, not at a wait timeout', async () => {
    // The stub ran, exited 0 and left an idle shell; no agent status, no new idle edge.
    const pane = createPane({ idle: true, tail: ['stub done', '$'], idleEdgeOnly: true })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS - 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
    expect(run.failed).not.toHaveBeenCalled()
  })

  it('keeps watching an agent past a tui-idle wait timeout and completes it later', async () => {
    const pane = createPane({ idle: false, tail: ['working'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(RUNTIME_TUI_IDLE_TIMEOUT_MS * 2 + 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    expect(run.failed).not.toHaveBeenCalled()

    pane.report()
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('stops on cancellation without recording any result', async () => {
    const pane = createPane({ idle: true, tail: ['$'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(5_000)
    run.controller.abort()
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS)
    await run.promise
    expect(run.settled).not.toHaveBeenCalled()
    expect(run.failed).toHaveBeenCalledWith(expect.objectContaining({ message: 'request_aborted' }))
  })
})
