import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../db/orchestration-db'

const dispatchMutations = new Set([
  'settleRemoteAttachmentInRelayTransaction',
  'completeDispatch',
  'failDispatch',
  'closeQuestionsForDispatch',
  'markWorkerDispatchReady',
  'failWorkerStart',
  'markWorkerStartUnknown',
  'abandonWorkerDispatch',
  'beginWorkerStop',
  'settleWorkerStop',
  'markWorkerStopUnknown',
  'reconcileMissingWorkerTerminal',
  'failRemoteAttachment',
  'markRemoteAttachmentReady',
  'beginRemoteAttachmentStop',
  'settleRemoteAttachmentStop',
  'markRemoteAttachmentStopUnknown',
  'requestRemoteAttachmentTerminalRelease'
])
const taskMutations = new Set([
  'completeActiveDispatchesForTask',
  'failActiveDispatchForTask',
  'promoteReadyTasks',
  'updateTaskStatus'
])

function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Capture both sides of transfers; nested mutations contribute their own scope before publication. */
export class CrewMailMutationScope {
  readonly trafficAddresses = new Set<string>()
  readonly mailboxOwners = new Set<string>()
  private readonly visited = new Set<string>()

  get notice() {
    return { trafficAddresses: this.trafficAddresses, mailboxOwners: this.mailboxOwners }
  }

  constructor(private readonly db: OrchestrationDb) {}

  run(id: string): void {
    this.trafficAddresses.add(`run:${id}`)
    if (this.seen(`run:${id}`)) {
      return
    }
    this.row(this.db.getRun(id))
  }

  dispatch(id: string): void {
    this.trafficAddresses.add(`dispatch:${id}`)
    if (this.seen(`dispatch:${id}`)) {
      return
    }
    this.row(this.db.getDispatchContextById(id) ?? this.db.getRemoteDispatchAttachment(id))
  }

  private seen(id: string): boolean {
    if (this.visited.has(id)) {
      return true
    }
    this.visited.add(id)
    return false
  }

  private task(id: string): void {
    if (this.seen(`task:${id}`)) {
      return
    }
    this.row(this.db.getTask(id))
    for (const row of this.db.db
      .prepare(
        "SELECT id FROM dispatch_contexts WHERE task_id = ? AND status IN ('pending', 'dispatched')"
      )
      .all(id)) {
      if (typeof row.id === 'string') {
        this.dispatch(row.id)
      }
    }
  }

  row(value: unknown): void {
    if (Array.isArray(value)) {
      for (const row of value) {
        this.row(row)
      }
    } else if (fields(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string') {
          if (['runId', 'run_id', 'local_run_id'].includes(key)) {
            this.run(item)
          }
          if (
            [
              'dispatchId',
              'dispatch_id',
              'owner_dispatch_id',
              'toDispatchId',
              'creatorDispatchId'
            ].includes(key)
          ) {
            this.dispatch(item)
          }
          if (['taskId', 'task_id'].includes(key)) {
            this.task(item)
          }
          if (
            [
              'paneKey',
              'pane_key',
              'fromPaneKey',
              'toPaneKey',
              'assigneePaneKey',
              'assignee_pane_key',
              'coordinatorPaneKey',
              'coordinator_pane_key',
              'creator_pane_key'
            ].includes(key)
          ) {
            this.mailboxOwners.add(item)
          }
          if (
            [
              'mailboxHandle',
              'from',
              'to',
              'from_handle',
              'to_handle',
              'assigneeHandle',
              'assignee_handle',
              'coordinatorHandle',
              'coordinator_handle',
              'terminalHandle',
              'terminal_handle'
            ].includes(key)
          ) {
            this.trafficAddresses.add(item)
          }
          if (
            [
              'coordinator_orca_session_id',
              'assignee_orca_session_id',
              'creator_orca_session_id'
            ].includes(key)
          ) {
            this.trafficAddresses.add(`orca_session_id:${item}`)
          }
          if (['messageId', 'message_id'].includes(key)) {
            this.row(this.db.getMessageById(item))
          }
          if (key === 'resourceId') {
            this.row(this.db.getWorkerTerminalResource(item))
          }
        } else if (item && typeof item === 'object') {
          this.row(item)
        }
      }
      if (typeof value.id === 'string') {
        if ('coordinator_pane_key' in value) {
          this.trafficAddresses.add(`run:${value.id}`)
        }
        if ('assignee_pane_key' in value) {
          this.trafficAddresses.add(`dispatch:${value.id}`)
        }
      }
    }
  }

  capture(name: string, args: unknown[]): void {
    const first = args[0]
    this.row(args)
    if (typeof first === 'string') {
      if (dispatchMutations.has(name)) {
        this.dispatch(first)
      }
      if (taskMutations.has(name)) {
        this.task(first)
      }
      if (name === 'resolveGate' || name === 'timeoutGate') {
        this.row(
          this.db.db.prepare('SELECT run_id, task_id FROM decision_gates WHERE id = ?').get(first)
        )
      }
      if (name === 'convertLifecycleMessageToRejection') {
        this.row(this.db.getMessageById(first))
      }
      if (name === 'settleWorkerTerminalRelease') {
        this.row(this.db.getWorkerTerminalResource(first))
      }
      if (name === 'routeDirectMessagePage') {
        this.trafficAddresses.add(first)
        if (typeof args[1] === 'string') {
          this.run(args[1])
        }
        if (typeof args[2] === 'string') {
          this.trafficAddresses.add(args[2])
        }
      }
      if (name === 'routeUnreadDispatchMailboxToRunMailbox') {
        this.dispatch(first)
        if (typeof args[1] === 'string') {
          this.run(args[1])
        }
      }
      if (name === 'routeForeignDirectMessagesToOwnedMailboxes') {
        this.trafficAddresses.add(first)
      }
    }
    if (name === 'unbindOtherRunsForCoordinator' && fields(first)) {
      const { paneKey, orcaSessionId, terminalHandle } = first
      if (
        (paneKey === null || typeof paneKey === 'string') &&
        (orcaSessionId === null ||
          (typeof orcaSessionId === 'string' && isOrcaSessionId(orcaSessionId))) &&
        (terminalHandle === null || typeof terminalHandle === 'string')
      ) {
        this.row(this.db.runsBoundToCoordinator({ paneKey, orcaSessionId, terminalHandle }))
      }
    }
    if (name === 'transitionLifecycle' && fields(first) && typeof first.id === 'string') {
      if (first.entity === 'run') {
        this.run(first.id)
      }
      if (first.entity === 'dispatch' || first.entity === 'worker') {
        this.dispatch(first.id)
      }
      if (first.entity === 'task') {
        this.task(first.id)
      }
    }
  }
}
