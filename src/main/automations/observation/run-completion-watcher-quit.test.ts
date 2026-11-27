import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AutomationDispatchResult,
  AutomationRun
} from '../../../shared/automations/history/automation-run'
import type { AgentTurnStatusRow } from '../../runtime/agent-state-rules/agent-turn-idle-verdict'
import { AutomationRunCompletionWatcher } from './run-completion-watcher'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'

const DISPATCHED_AT = 1_000

function dispatchedRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    title: 'Nightly',
    scheduledFor: DISPATCHED_AT,
    status: 'dispatched',
    trigger: 'manual',
    workspaceId: 'ws-1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    terminalPaneKey: 'tab-1:1',
    terminalPtyId: 'pty-1',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: DISPATCHED_AT,
    dispatchedAt: DISPATCHED_AT,
    createdAt: DISPATCHED_AT
  }
}

type RunHistory = { run: AutomationRun; results: AutomationDispatchResult[] }

function freshHistory(): RunHistory {
  return { run: dispatchedRun(), results: [] }
}

/** One Orca process: its window graph, its view of the agent's status, and the run history it writes. */
function startOrca(history: RunHistory) {
  let graphAvailable = true
  let quitting = false
  const pendingWaits: ((error: Error) => void)[] = []
  const rows: AgentTurnStatusRow[] = []
  let idle = false
  const host: AutomationRunTerminalHost = {
    getTerminalHandleForPaneKey: () => 'term-1',
    canOpenRunTerminals: () => graphAvailable,
    readTerminal: async () => ({ tail: idle ? ['DONE', '$ '] : ['working'] }),
    waitForTerminal: (_handle, options) => {
      if (!graphAvailable) {
        return Promise.reject(new Error('runtime_unavailable'))
      }
      if (idle) {
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((_resolve, reject) => {
        pendingWaits.push(reject)
        options?.signal?.addEventListener('abort', () => reject(new Error('request_aborted')))
      })
    }
  }
  const watcher = new AutomationRunCompletionWatcher({
    observer: createRuntimeAutomationRunTerminalObserver(host, {
      getAgentStatusRowsForPane: () => rows,
      getAcceptedReply: () => undefined,
      subscribeStatusChanges: () => () => {},
      agentCommandsForRun: () => ['claude']
    }),
    readRun: () => history.run,
    markDispatchResult: async (result) => {
      history.results.push(result)
      history.run = { ...history.run, status: result.status }
    },
    isHostQuitting: () => quitting
  })
  return {
    watcher,
    /** The native updater starts closing windows; preparing an install alone does not count. */
    startNativeUpdateInstall: () => {
      quitting = true
    },
    /** Electron closes the window graph, then drains microtasks before will-quit runs. */
    closeWindow: async () => {
      graphAvailable = false
      for (const reject of pendingWaits.splice(0)) {
        reject(new Error('terminal_handle_stale'))
      }
      for (let i = 0; i < 20; i += 1) {
        await Promise.resolve()
      }
    },
    agentFinished: () => {
      idle = true
      rows.push({ state: 'done', stateStartedAt: DISPATCHED_AT + 5_000 })
    }
  }
}

const settle = () => vi.runAllTimersAsync()

describe('AutomationRunCompletionWatcher across an Orca quit', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves a run watched at quit for the next start, which completes it from the agent done', async () => {
    const history = freshHistory()
    const first = startOrca(history)
    first.watcher.watch(history.run)
    await settle()

    await first.closeWindow()
    first.watcher.dispose()
    await settle()
    expect(history.results).toEqual([])
    expect(history.run.status).toBe('dispatched')

    const second = startOrca(history)
    second.agentFinished()
    second.watcher.reconcileRetainedRuns([history.run])
    await settle()
    expect(history.results.map((result) => result.status)).toEqual(['completed'])
  })

  it('leaves a run watched when the native update install closes the window long before will-quit', async () => {
    const history = freshHistory()
    const orca = startOrca(history)
    orca.watcher.watch(history.run)
    await settle()

    orca.startNativeUpdateInstall()
    await orca.closeWindow()
    await settle()
    orca.watcher.dispose()
    expect(history.results).toEqual([])
    expect(history.run.status).toBe('dispatched')
  })

  it('fails a run whose wait broke with no quit under way', async () => {
    const history = freshHistory()
    const orca = startOrca(history)
    orca.watcher.watch(history.run)
    await settle()

    await orca.closeWindow()
    await settle()
    expect(history.results.map((result) => result.status)).toEqual(['dispatch_failed'])
  })
})

describe('AutomationRunCompletionWatcher restart with a chat run', () => {
  function chatRun(id: string): AutomationRun {
    return {
      ...dispatchedRun(),
      id,
      sessionKind: 'chat',
      chatSessionId: `chat-${id}`,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null
    }
  }

  it('settles dispatched chat runs from their chat, whether it already finished or finishes later', async () => {
    const runs = new Map([chatRun('done'), chatRun('running')].map((run) => [run.id, run]))
    const results: AutomationDispatchResult[] = []
    let finishRunning = (): void => {}
    const watcher = new AutomationRunCompletionWatcher({
      // As the runtime routes chat runs: the run's own chat says when it ends.
      observer: {
        resolveRunTerminal: (run) => (run.sessionKind === 'chat' ? `automation:${run.id}` : null),
        observeCompletion: async (handle) =>
          handle === 'automation:done'
            ? { status: 'completed' }
            : new Promise((resolve) => {
                finishRunning = () => resolve({ status: 'completed' })
              })
      },
      readRun: (_automationId, runId) => runs.get(runId) ?? null,
      markDispatchResult: async (result) => {
        results.push(result)
        runs.set(result.runId, { ...runs.get(result.runId)!, status: result.status })
      }
    })

    watcher.reconcileRetainedRuns([...runs.values()])
    await Promise.resolve()
    await Promise.resolve()
    expect(results.map((result) => [result.runId, result.status])).toEqual([['done', 'completed']])

    finishRunning()
    await vi.waitFor(() => expect(runs.get('running')?.status).toBe('completed'))
    expect(results.map((result) => result.chatSessionId)).toEqual(['chat-done', 'chat-running'])
    watcher.dispose()
  })
})
