import { RecentPtyOutputBuffer } from '../runtime/recent-pty-output-buffer'
import { normalizeTerminalChunk } from '../runtime/terminal-ansi-normalization'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { AutomationRun } from '../../shared/automations-types'
import { AGENT_START_GRACE_MS } from './automation-run-agent-evidence'
import { codexBootstrapFailureTail } from './codex-bootstrap-failure.test-fixture'
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
  const output = new RecentPtyOutputBuffer()
  output.append(tail.join('\n'))
  let rows: StatusRow[] = []
  const waiters = new Set<() => void>()
  const runtime: AutomationRunTerminalHost = {
    getTerminalHandleForPaneKey: () => HANDLE,
    readTerminal: async () => ({ tail }),
    readTerminalOutputSince: (_handle, boundary) => {
      const raw = output.readSince(boundary)
      return raw === null
        ? null
        : { output: normalizeTerminalChunk(raw.output).text.split('\n'), complete: raw.complete }
    },
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
    output,
    boundary: (fresh = true) => ({ ...output.boundary(), ...(fresh ? { offset: 0 } : {}) }),
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
  },
  commands = ['goose'],
  terminalOutputBoundary: AutomationRun['terminalOutputBoundary'] = pane.boundary()
) {
  const observer = createRuntimeAutomationRunTerminalObserver(pane.runtime, {
    getAgentStatusRowsForPane: (paneKey) => (paneKey === PANE_KEY ? pane.agentRows() : []),
    agentCommandsForRun: () => commands
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer reads only these run fields.
  const run = {
    terminalPaneKey: PANE_KEY,
    terminalOutputBoundary,
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
  it('does not fail a new run on a reused pane before any new banner or status', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    const run = observe(pane, undefined, undefined, ['codex'], pane.boundary(false))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).not.toHaveBeenCalled()
    run.controller.abort()
    await run.promise
  })

  it.each([false, true])(
    'waits after output generation replacement, with new failure: %s',
    async (newFailure) => {
      const previous = createPane({ idle: true, tail: ['launching Codex'] })
      const savedBoundary = previous.boundary(false)
      const pane = createPane({ idle: true, tail: ['$'] })
      if (newFailure) {
        pane.output.append(codexBootstrapFailureTail.join('\n'))
        pane.setTail(codexBootstrapFailureTail)
      }
      const run = observe(pane, undefined, undefined, ['codex'], savedBoundary)
      await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
      expect(run.settled).not.toHaveBeenCalled()
      expect(run.failed).not.toHaveBeenCalled()
      pane.report()
      await vi.advanceTimersByTimeAsync(1_000)
      await run.promise
      expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
    }
  )

  it('does not infer a bootstrap failure without a launch boundary from an older caller', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    const run = observe(pane, undefined, undefined, ['codex'], null)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('allows status-free completion after grace with a complete empty launch read', async () => {
    const pane = createPane({ idle: true, tail: ['$'] })
    const run = observe(pane, undefined, undefined, ['codex'], pane.boundary(false))
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS - 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('waits when a saved boundary cannot be read by an older host', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    delete pane.runtime.readTerminalOutputSince
    const run = observe(pane, undefined, undefined, ['codex'])
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    run.controller.abort()
    await run.promise
  })

  it('detects a new split ANSI bootstrap failure even when observation starts late', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    const boundary = pane.boundary(false)
    const failure = `\n${codexBootstrapFailureTail.join('\n')}\n`
    for (const character of `\x1b[32m${failure}\x1b[0m`) {
      pane.output.append(character)
    }
    await vi.advanceTimersByTimeAsync(20_000)
    const run = observe(pane, undefined, undefined, ['codex'], boundary)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        errorCode: 'codexBootstrapFailed'
      })
    )
  })

  it('retains a current bootstrap failure when a large historical snapshot arrives late', async () => {
    const pane = createPane({ idle: true, tail: ['$'] })
    const boundary = pane.boundary(false)
    pane.output.append(codexBootstrapFailureTail.join('\n'))
    pane.output.appendHistorical('old snapshot\n'.repeat(6_000))
    const run = observe(pane, undefined, undefined, ['codex'], boundary)
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dispatch_failed', errorCode: 'codexBootstrapFailed' })
    )
  })

  it('waits when live output evicts an earlier bootstrap failure, until fresh done', async () => {
    const pane = createPane({ idle: true, tail: ['$'] })
    const boundary = pane.boundary(false)
    pane.output.append(`${codexBootstrapFailureTail.join('\n')}\n`)
    pane.output.append('shell prompt noise\n'.repeat(4_000))
    const run = observe(pane, undefined, undefined, ['codex'], boundary)
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    expect(run.failed).not.toHaveBeenCalled()
    pane.report()
    await vi.advanceTimersByTimeAsync(1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('reports a typed bootstrap failure after current-launch output rolls past retention', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    const boundary = pane.boundary(false)
    pane.output.append('startup noise\n'.repeat(6_000))
    pane.output.append(`\n${codexBootstrapFailureTail.join('\n')}`)
    const run = observe(pane, undefined, undefined, ['codex'], boundary)
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        errorCode: 'codexBootstrapFailed'
      })
    )
  })

  it('fails a Codex bootstrap refusal after the shell returns, with a recovery action', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    const run = observe(pane, undefined, undefined, ['codex'])
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatch_failed',
        errorCode: 'codexBootstrapFailed',
        error: expect.stringContaining('Run now'),
        outputSnapshot: expect.objectContaining({
          content: expect.stringContaining('workspace routing discovery failed')
        })
      })
    )
  })

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

  it('completes a fresh genuine done despite the historical bootstrap failure', async () => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    pane.report()
    const run = observe(pane, undefined, undefined, ['codex'])
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it.each([
    { state: 'working' as const },
    { state: 'waiting' as const },
    { state: 'blocked' as const },
    { state: 'done' as const, sessionBoundary: true },
    { state: 'done' as const, stateStartedAt: 0 }
  ])('preserves uncertain ownership with $state status and old failure output', async (row) => {
    const pane = createPane({ idle: true, tail: codexBootstrapFailureTail })
    pane.report(row)
    const run = observe(pane, undefined, undefined, ['codex'])
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    expect(run.settled).not.toHaveBeenCalled()
    run.controller.abort()
    await run.promise
  })

  it('ignores a prior bootstrap failure before a later Codex startup banner', async () => {
    const pane = createPane({
      idle: true,
      tail: [...codexBootstrapFailureTail, '>_ OpenAI Codex (v0.165.0)', 'Task finished', '$']
    })
    const run = observe(pane, undefined, undefined, ['codex'])
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
  })

  it('does not treat another agent reporting a Codex failure as a refused launch', async () => {
    const run = observe(createPane({ idle: true, tail: codexBootstrapFailureTail }))
    await vi.advanceTimersByTimeAsync(AGENT_START_GRACE_MS + 1_000)
    await run.promise
    expect(run.settled).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }))
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
