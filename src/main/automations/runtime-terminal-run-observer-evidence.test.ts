import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { AutomationRun } from '../../shared/automations-types'
import { AGENT_START_GRACE_MS } from './automation-run-agent-evidence'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const HANDLE = 'terminal-1'
const PANE_KEY = 'tab-1:pane-1'
const RUNTIME_TUI_IDLE_TIMEOUT_MS = 5 * 60 * 1000

type StatusRow = {
  state: AgentStatusState
  receivedAt: number
  stateStartedAt: number
  sessionBoundary?: boolean
}

function createPane(initial: { idle: boolean; tail: string[]; idleEdgeOnly?: boolean }) {
  let idle = initial.idle
  // Model runtimes that satisfy tui-idle only once per idle edge.
  let edgeSpent = false
  let tail = initial.tail
  let rows: StatusRow[] = []
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
    report: (row: Partial<StatusRow> = {}) =>
      (rows = [{ state: 'done', receivedAt: Date.now(), stateStartedAt: Date.now(), ...row }]),
    setTail: (next: string[]) => (tail = next),
    becomeBusy: () => {
      idle = false
    },
    becomeIdle: () => {
      idle = true
      for (const wake of waiters) {
        waiters.delete(wake)
        wake()
      }
    }
  }
}

function observe(
  pane: ReturnType<typeof createPane>,
  controller = new AbortController(),
  times: Pick<AutomationRun, 'startedAt' | 'dispatchedAt'> = {
    startedAt: Date.now(),
    dispatchedAt: null
  }
) {
  const observer = createRuntimeAutomationRunTerminalObserver(pane.runtime, {
    getAgentStatusRowsForPane: (paneKey) => (paneKey === PANE_KEY ? pane.agentRows() : []),
    agentCommandsForRun: () => ['goose']
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only these run fields.
  const run = {
    terminalPaneKey: PANE_KEY,
    ...times
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

  it("waits out a reused pane's previous done until this run's turn is done", async () => {
    const pane = createPane({ idle: true, tail: ['previous summary', '❯'] })
    // A reconnect replay restamps receivedAt; the done itself still predates the run.
    pane.report({ stateStartedAt: Date.now() - 60_000 })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.settled).not.toHaveBeenCalled()

    pane.becomeBusy()
    pane.setTail(['previous summary', '❯ nightly prompt', 'working'])
    pane.report({ state: 'working' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.settled).not.toHaveBeenCalled()

    pane.report()
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it.each([
    ['a working row', { state: 'working' as const }],
    ['a connect-time done', { sessionBoundary: true }]
  ])('does not read %s on an idle pane as the run finishing', async (_label, row) => {
    const pane = createPane({ idle: true, tail: ['❯'] })
    pane.report(row)
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS - 1_000)
    expect(run.settled).not.toHaveBeenCalled()
  })

  it('does not take the done of a run that finished while this one waited in its precheck', async () => {
    const startedAt = Date.now()
    await vi.advanceTimersByTimeAsync(60_000)
    const pane = createPane({ idle: true, tail: ['other run summary', '❯'] })
    pane.report()
    await vi.advanceTimersByTimeAsync(30_000)
    const run = observe(pane, undefined, { startedAt, dispatchedAt: Date.now() })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.settled).not.toHaveBeenCalled()

    pane.becomeBusy()
    pane.setTail(['other run summary', '❯ nightly prompt', 'working'])
    pane.report({ state: 'working' })
    await vi.advanceTimersByTimeAsync(5_000)
    pane.report()
    pane.becomeIdle()
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('completes a turn that ended before the launch returned', async () => {
    const dispatchedAt = Date.now()
    await vi.advanceTimersByTimeAsync(1_000)
    const pane = createPane({ idle: true, tail: ['summary written', '❯'] })
    pane.report()
    await vi.advanceTimersByTimeAsync(1_000)
    const run = observe(pane, undefined, { startedAt: dispatchedAt, dispatchedAt })
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('never completes a reused pane on its old done after a long precheck, past any grace', async () => {
    const pane = createPane({ idle: true, tail: ['previous summary', '❯'] })
    pane.report({ stateStartedAt: Date.now() - 600_000 })
    const run = observe(pane, undefined, {
      startedAt: Date.now() - 180_000,
      dispatchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS * 3)
    expect(run.settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed', error: expect.stringContaining('6h') })
    )
  })

  it("measures a hookless agent's start window from dispatch, not from before its precheck", async () => {
    const pane = createPane({ idle: true, tail: ['summary written', '$'] })
    const run = observe(pane, undefined, {
      startedAt: Date.now() - 180_000,
      dispatchedAt: Date.now()
    })
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

  it("completes on the agent's own done when the screen never reads idle (#34064)", async () => {
    // A finished pane whose title and screen lost their rest evidence, e.g. after a stream gap.
    const pane = createPane({ idle: false, tail: ['done', '❯'] })
    const run = observe(pane)
    await vi.advanceTimersByTimeAsync(5_000)
    pane.report()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run.settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
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
