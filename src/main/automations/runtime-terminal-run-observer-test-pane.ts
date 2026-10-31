import { vi } from 'vitest'
import type { AgentStatusState } from '../../shared/agent-status-types'
import type { AutomationRun } from '../../shared/automations-types'
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
  lastAssistantMessage?: string
  lastAssistantMessageIsToolOutput?: boolean
}

export function createPane(initial: { idle: boolean; tail: string[]; idleEdgeOnly?: boolean }) {
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

export function observe(
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
  const run: AutomationRun = {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Test run',
    scheduledFor: Date.now(),
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: PANE_KEY,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    createdAt: Date.now(),
    ...times
  }
  const settled = vi.fn()
  const failed = vi.fn()
  const promise = observer
    .observeCompletion(HANDLE, { signal: controller.signal, run })
    .then(settled, failed)
  return { settled, failed, promise, controller }
}
