import { randomUUID } from 'node:crypto'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { normalizeOptionalField } from '../../../../shared/agent-status/contracts/agent-status-field-normalization'

// Past this a long-polling reader re-snapshots instead of replaying.
const STATE_JOURNAL_LIMIT = 512
const TRACKED_PANE_LIMIT = 2048
const BLOCKED_ON_MAX_LENGTH = 200
// A reader gone longer than this resumes from a snapshot, so hook rows cost nothing meanwhile.
const READER_GRACE_MS = 2 * 60 * 1000

export type RunWorkerStateEvent = {
  type: 'worker_state'
  runId: string
  dispatchId: string
  taskId: string
  state: AgentStatusIpcPayload['state']
  since: string
  lastTool?: string
  blockedOn?: string
  snapshot?: true
}

export function runWorkerStateEvent(
  runId: string,
  dispatch: { dispatchId: string; taskId: string },
  row: AgentStatusIpcPayload
): RunWorkerStateEvent {
  const blockedOn =
    row.state === 'blocked' || row.state === 'waiting'
      ? normalizeOptionalField(row.interactivePrompt, BLOCKED_ON_MAX_LENGTH)
      : undefined
  return {
    type: 'worker_state',
    runId,
    dispatchId: dispatch.dispatchId,
    taskId: dispatch.taskId,
    state: row.state,
    since: new Date(row.stateStartedAt).toISOString(),
    ...(row.toolName ? { lastTool: row.toolName } : {}),
    ...(blockedOn ? { blockedOn } : {})
  }
}

/**
 * Wakes orchestration.events readers beside the mail waiters, never as one: a waiter on a
 * mailbox counts as its consumer and would suppress the coordinator's pointer delivery.
 */
export class RunEventObservers {
  /** Tells a cursor from this process apart from one minted before a restart. */
  readonly epoch = randomUUID().slice(0, 8)
  private wakes = 0
  private readonly listeners = new Set<() => void>()
  private stateSequence = 0
  private readonly journal: (RunWorkerStateEvent & { sequence: number })[] = []
  private readonly paneStates = new Map<
    string,
    { dispatchId: string | null; state: AgentStatusIpcPayload['state'] }
  >()
  private lastReadAt = -Infinity

  get wakeCount(): number {
    return this.wakes
  }

  get stateCursor(): number {
    return this.stateSequence
  }

  /** Marks a reader present; a pending poll counts as present on its own. */
  noteReader(): void {
    this.lastReadAt = Date.now()
  }

  wake(): void {
    this.wakes += 1
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** True on the first wake after `seen`, false on timeout or abort. */
  waitAfter(seen: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.wakes > seen) {
      return Promise.resolve(true)
    }
    if (signal?.aborted) {
      return Promise.resolve(false)
    }
    return new Promise((resolve) => {
      const finish = (woke: boolean): void => {
        clearTimeout(timer)
        this.listeners.delete(onWake)
        signal?.removeEventListener('abort', onAbort)
        resolve(woke)
      }
      const onWake = (): void => finish(true)
      const onAbort = (): void => finish(false)
      const timer = setTimeout(onAbort, timeoutMs)
      this.listeners.add(onWake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Journal a worker's hook state when it changes; tool-only updates are not events. */
  noteWorkerState(
    paneKey: string,
    row: AgentStatusIpcPayload | null,
    readContext: () => AgentStatusOrchestrationContext | undefined
  ): void {
    if (this.listeners.size === 0 && Date.now() - this.lastReadAt > READER_GRACE_MS) {
      if (this.paneStates.size > 0 || this.journal.length > 0) {
        // Changes go unrecorded from here, so no cursor minted so far may replay past them.
        this.paneStates.clear()
        this.journal.length = 0
        this.stateSequence += 1
      }
      return
    }
    if (!row) {
      this.paneStates.delete(paneKey)
      return
    }
    const known = this.paneStates.get(paneKey)
    // An unbound pane re-resolves each row: its Dispatch may bind after the state was first seen.
    if (known?.state === row.state && known.dispatchId !== null) {
      return
    }
    const context = readContext()
    const dispatchId = context?.orchestrationRunId ? context.dispatchId : null
    if (known?.state === row.state && dispatchId === null) {
      return
    }
    this.paneStates.delete(paneKey)
    this.paneStates.set(paneKey, { dispatchId, state: row.state })
    if (this.paneStates.size > TRACKED_PANE_LIMIT) {
      this.paneStates.delete(this.paneStates.keys().next().value!)
    }
    if (!context?.orchestrationRunId) {
      return
    }
    this.journal.push({
      ...runWorkerStateEvent(context.orchestrationRunId, context, row),
      sequence: ++this.stateSequence
    })
    if (this.journal.length > STATE_JOURNAL_LIMIT) {
      this.journal.shift()
    }
    this.wake()
  }

  /** State changes after `sequence`, or undefined when the journal cannot prove it has them all. */
  statesSince(
    sequence: number
  ): readonly (RunWorkerStateEvent & { sequence: number })[] | undefined {
    const oldest = this.journal[0]?.sequence ?? this.stateSequence + 1
    if (sequence > this.stateSequence || sequence < oldest - 1) {
      return undefined
    }
    return this.journal.filter((entry) => entry.sequence > sequence)
  }
}
