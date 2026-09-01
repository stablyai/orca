import type { OrchestrationDb } from './db'
import type { CoordinatorRuntime } from './coordinator-runtime-contract'

export type DriftResult = {
  base: string
  behind: number
  recentSubjects: string[]
} | null

export function createMockRuntime(): CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  createdTerminals: string[]
  createdTerminalOptions: { title?: string }[]
  probeDriftCalls: string[]
  probeDriftResult: DriftResult
  cliCommand: 'orca' | 'orca-ide'
  setProbeDrift(result: DriftResult): void
  throwProbeDrift: Error | null
} {
  const mock = {
    sentMessages: [] as { handle: string; text: string }[],
    terminals: [] as {
      handle: string
      worktreeId: string
      connected: boolean
      writable: boolean
    }[],
    createdTerminals: [] as string[],
    createdTerminalOptions: [] as { title?: string }[],
    probeDriftCalls: [] as string[],
    probeDriftResult: null as DriftResult,
    cliCommand: 'orca' as 'orca' | 'orca-ide',
    throwProbeDrift: null as Error | null,
    setProbeDrift(result: DriftResult): void {
      mock.probeDriftResult = result
    },
    async sendTerminalAgentPrompt(handle: string, prompt: string) {
      mock.sentMessages.push({ handle, text: prompt })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal(_worktree?: string, opts?: { title?: string }) {
      const handle = `term_worker_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      mock.createdTerminalOptions.push(opts ?? {})
      mock.terminals.push({ handle, worktreeId: 'wt1', connected: true, writable: true })
      return { handle, worktreeId: 'wt1', title: opts?.title ?? '' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    },
    async probeWorktreeDrift(worktreeSelector: string): Promise<DriftResult> {
      mock.probeDriftCalls.push(worktreeSelector)
      if (mock.throwProbeDrift) {
        throw mock.throwProbeDrift
      }
      return mock.probeDriftResult
    },
    getTerminalOrchestrationCliCommand() {
      return mock.cliCommand
    }
  }
  return mock
}

export function insertWorkerDone(
  db: OrchestrationDb,
  params: {
    taskId: string
    to?: string
    from?: string
    dispatchId?: string
    filesModified?: string[]
    senderPaneKey?: string
  }
): void {
  const dispatch = db.getDispatchContext(params.taskId)
  const dispatchId = params.dispatchId ?? dispatch?.id
  if (!dispatchId) {
    throw new Error(`No dispatch for task ${params.taskId}`)
  }
  const from = params.from ?? dispatch?.assignee_handle ?? 'term_unknown'
  db.insertMessage({
    from,
    to: params.to ?? 'coord',
    subject: 'Done',
    type: 'worker_done',
    payload: JSON.stringify({
      taskId: params.taskId,
      dispatchId,
      outcome: 'succeeded',
      ...(params.filesModified ? { filesModified: params.filesModified } : {})
    }),
    senderPaneKey:
      params.senderPaneKey ??
      (from === dispatch?.assignee_handle ? (dispatch.assignee_pane_key ?? undefined) : undefined)
  })
}
