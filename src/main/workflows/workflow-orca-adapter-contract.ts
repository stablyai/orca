import type { TaskStatus } from '../runtime/orchestration/types'
import type {
  WorkflowMailMessage,
  WorkflowOrcaDispatchSnapshot,
  WorkflowOrcaTaskSnapshot,
  WorkflowWorkerStartReceipt
} from './workflow-orca-receipts'
import type { CapturedWorkflowAnswer } from './workflow-worker-answer-capture'

export type WorkflowOrcaAdapter = {
  createCoordinatorTerminal(args: {
    worktreeSelector: string
    title: string
    requestId: string
  }): Promise<string>
  createRun(args: { from: string; objective: string; requestId: string }): Promise<string>
  createTask(args: {
    from: string
    orcaRunId: string
    spec: string
    title: string
    displayName: string
    requestId: string
  }): Promise<string>
  startWorker(args: {
    from: string
    orcaRunId: string
    orcaTaskId: string
    agent: string
    model: string | null
    effort: string | null
    worktree: string
    displayName: string
    timeoutMs: number | null
    /** The previous attempt's Dispatch, so Orca records the retry lineage. */
    retryOf: string | null
    requestId: string
  }): Promise<WorkflowWorkerStartReceipt>
  /** Holds Orca's unfiltered waiter on the Run mailbox, which also keeps mail pointers off the coordinator terminal. */
  waitForMail(args: {
    from: string
    orcaRunId: string
    ack: string | null
    timeoutMs: number
  }): Promise<{ deliveryId: string | null; messages: WorkflowMailMessage[] }>
  sendToDispatch(args: {
    from: string
    orcaRunId: string
    dispatchId: string
    subject: string
    body: string
    requestId: string
  }): Promise<string | null>
  createGate(args: {
    from: string
    orcaRunId: string
    orcaTaskId: string
    question: string
    requestId: string
  }): Promise<string | null>
  resolveGate(args: {
    from: string
    orcaRunId: string
    gateId: string
    resolution: string
    requestId: string
  }): Promise<void>
  updateTask(args: {
    orcaRunId: string
    orcaTaskId: string
    status: TaskStatus
    result: string
    requestId: string
  }): Promise<void>
  stopWorker(args: { dispatchId: string; requestId: string }): Promise<string>
  reply(args: {
    from: string
    orcaRunId: string
    messageId: string
    body: string
    requestId: string
  }): Promise<void>
  /** After a restart replaced the coordinator terminal, bind the Run to the new one. */
  rebindRun(args: { from: string; orcaRunId: string; requestId: string }): Promise<void>
  closeTerminal(handle: string): Promise<void>
  /** CLI agents found on this host's PATH; null when detection could not answer. */
  detectAgents(): Promise<string[] | null>
  /** Installed skill names on this host; null when discovery could not answer. */
  installedSkills(): Promise<string[] | null>
  /** What the worker wrote while working; null when nothing readable remains. */
  readWorkerAnswer(args: {
    orcaDispatchId: string
    terminalHandle: string | null
    startedAtMs: number
  }): Promise<CapturedWorkflowAnswer | null>
  readTask(orcaTaskId: string): WorkflowOrcaTaskSnapshot | null
  readDispatch(orcaDispatchId: string): WorkflowOrcaDispatchSnapshot | null
  terminalExists(handle: string): boolean
  paneKeyFor(handle: string): string | null
}
