import {
  REMOTE_OWNED_ITEM_KINDS,
  type RemoteOwnedWorkerMail,
  type RemoteOwnedWorkerState
} from '../../../../../shared/orchestration/remote-owned-wire'
import { OrchestrationError } from '../../orchestration-error'
import type { MessageType } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import { presentImportedPeerItem } from '../../mailbox/formatting/imported-peer-item-presentation'
import {
  reconcileTaskAfterDispatchInterruption,
  settleTaskAfterLostWorker
} from '../dispatch-context/task-dispatch-reconciliation'
import { runLifecycleWriteTransaction } from '../lifecycle-write-transaction-runner'
import {
  abandonRemoteDispatchStop,
  isRemoteDispatchTerminal,
  recordRemoteDispatchReport,
  recordRemoteDispatchState
} from './remote-dispatch-records'
import {
  adoptRemoteAttempt,
  currentRemoteAttempt,
  noteRemoteRunLinkPeerRun
} from './remote-placements'
import {
  closeRemoteRunLink,
  getRemoteRunLink,
  remoteRunLinkPinMatches,
  type RemoteRunLinkRow,
  type RemoteServerPin
} from './remote-run-links'

export type PulledRemoteOwnedItem = {
  conversationId: string
  sequence: number
  messageId: string
  kind?: string
  payload: string
}

/** Mail to wake its mailbox for once the import commits. */
export type ImportedRemoteOwnedMail = { to: string; type: MessageType }

/**
 * Imports one item of a link's queue, with everything it implies, in one transaction that also
 * advances the link's import position; an item at or below it was already imported and does
 * nothing. Throws on anything it cannot read, so the pull stops and the item is never acked.
 */
export function importRemoteOwnedItem(
  db: OrchestrationDb,
  server: RemoteServerPin,
  item: PulledRemoteOwnedItem,
  /** For a link a re-pair closed: the server's name, and how to wake the Run's coordinator. */
  onClose: { name: string; notify?: (handle: string, messageType: string) => void } = {
    name: server.environment_id
  }
): ImportedRemoteOwnedMail | undefined {
  const parsed = parseRemoteOwnedItem(item)
  return runLifecycleWriteTransaction(db.db, 'import_remote_owned_item', () => {
    const link = getRemoteRunLink(db, item.conversationId)
    if (!link || link.environment_id !== server.environment_id) {
      throw unreadable(item, `it names no Run this Orca placed on ${server.environment_id}`)
    }
    if (item.sequence <= link.last_imported_sequence) {
      return undefined
    }
    advanceImportPosition(db, link, item.sequence)
    // A reset or re-pair since then: the item is read and acknowledged, and records nothing.
    if (link.state === 'open' && !remoteRunLinkPinMatches(link, server)) {
      closeRemoteRunLink(
        db,
        link.conversation_id,
        `The pairing with ${onClose.name} was re-made.`,
        onClose.notify
      )
    }
    if (link.state !== 'open' || !remoteRunLinkPinMatches(link, server)) {
      return undefined
    }
    if (parsed.value.homeRunId !== link.run_id) {
      throw unreadable(item, `it belongs to Run ${parsed.value.homeRunId}, not ${link.run_id}`)
    }
    if (link.peer_run_id !== null && parsed.value.peerRunId !== link.peer_run_id) {
      throw unreadable(
        item,
        `it comes from peer Run ${parsed.value.peerRunId}, not ${link.peer_run_id}`
      )
    }
    noteRemoteRunLinkPeerRun(db, link.conversation_id, parsed.value.peerRunId)
    return parsed.kind === 'worker_mail'
      ? importWorkerMail(db, link, parsed.value)
      : importWorkerState(db, link, parsed.value)
  })
}

type ParsedItem =
  | { kind: 'worker_mail'; value: RemoteOwnedWorkerMail }
  | { kind: 'worker_state'; value: RemoteOwnedWorkerState }

function parseRemoteOwnedItem(item: PulledRemoteOwnedItem): ParsedItem {
  let json: unknown
  try {
    json = JSON.parse(item.payload)
  } catch {
    throw unreadable(item, 'its payload is not JSON')
  }
  const parsed = parseKind(item.kind, json)
  if (!parsed) {
    throw unreadable(item, `its kind ${item.kind ?? '(none)'} is not one this Orca reads`)
  }
  if (!parsed.success) {
    throw unreadable(item, `its payload does not match ${item.kind}: ${parsed.error}`)
  }
  if (parsed.item.value.id !== item.messageId) {
    throw unreadable(item, `its payload names ${parsed.item.value.id}`)
  }
  return parsed.item
}

function parseKind(
  kind: string | undefined,
  json: unknown
): { success: true; item: ParsedItem } | { success: false; error: string } | undefined {
  if (kind === 'worker_mail') {
    const result = REMOTE_OWNED_ITEM_KINDS.worker_mail.safeParse(json)
    return result.success
      ? { success: true, item: { kind, value: result.data } }
      : { success: false, error: result.error.issues[0]?.message ?? 'invalid' }
  }
  if (kind === 'worker_state') {
    const result = REMOTE_OWNED_ITEM_KINDS.worker_state.safeParse(json)
    return result.success
      ? { success: true, item: { kind, value: result.data } }
      : { success: false, error: result.error.issues[0]?.message ?? 'invalid' }
  }
  return undefined
}

function unreadable(item: PulledRemoteOwnedItem, why: string): OrchestrationError {
  return new OrchestrationError(
    'invalid_argument',
    `Queue item ${item.messageId} (sequence ${item.sequence}) from a paired server was not imported: ${why}.`
  )
}

function advanceImportPosition(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  sequence: number
): void {
  db.db
    .prepare(`UPDATE remote_run_links SET last_imported_sequence = ? WHERE conversation_id = ?`)
    .run(sequence, link.conversation_id)
}

function importWorkerMail(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  mail: RemoteOwnedWorkerMail
): ImportedRemoteOwnedMail | undefined {
  if (mail.dispatchId && mail.taskId) {
    adoptRemoteAttempt(db, link, { taskId: mail.taskId, dispatchId: mail.dispatchId })
    if (mail.message.type === 'worker_done') {
      recordRemoteDispatchReport(db, mail.dispatchId, mail.message.subject)
    }
    if (mail.message.type === 'question') {
      db.db
        .prepare(
          `INSERT OR IGNORE INTO remote_owned_questions (
             message_id, conversation_id, run_id, environment_id, dispatch_id
           ) VALUES (?, ?, ?, ?, ?)`
        )
        .run(mail.id, link.conversation_id, link.run_id, link.environment_id, mail.dispatchId)
    }
  }
  if (db.getMessageById(mail.id)) {
    return undefined
  }
  const to = `run:${link.run_id}`
  const presented = presentImportedPeerItem({
    kind: 'worker_mail',
    from: mail.message.from,
    body: mail.message.body
  })
  db.insertMessage({
    id: mail.id,
    from: presented.from,
    to,
    subject: mail.message.subject,
    body: presented.body,
    type: mail.message.type,
    priority: mail.message.priority,
    threadId: mail.message.threadId ?? undefined,
    payload: mail.message.payload ?? undefined,
    runId: link.run_id
  })
  return { to, type: mail.message.type }
}

function importWorkerState(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  state: RemoteOwnedWorkerState
): undefined {
  const { dispatch, task } = state
  adoptRemoteAttempt(db, link, {
    taskId: dispatch.taskId,
    dispatchId: dispatch.id,
    agent: dispatch.agent
  })
  const record = recordRemoteDispatchState(
    db,
    dispatch.id,
    state.removed
      ? // The server deleted it without a stop, as any reset does; nothing there answers for it now.
        {
          status: 'failed',
          worker_state: 'abandoned',
          last_failure: state.removed.reason,
          agent: dispatch.agent
        }
      : {
          status: dispatch.status,
          worker_state: dispatch.workerState,
          last_failure: dispatch.lastFailure,
          agent: dispatch.agent
        }
  )
  if (state.removed) {
    // No stop there can prove anything about a Dispatch its reset deleted, so nothing is owed for it.
    abandonRemoteDispatchStop(db, dispatch.id)
  }
  // The Task here follows the server's Task through the ordinary owner's Task half, unless this
  // Orca already settled it for this attempt: the first result stands.
  // The server's restart recovery lost its worker and readied its Task: as the local rule does,
  // the Task here is ready for a fresh start. Ready is no result, so it applies even if settled here.
  if (
    task.status === 'ready' &&
    !state.removed &&
    isRemoteDispatchTerminal(record) &&
    currentRemoteAttempt(db, dispatch.taskId)?.dispatch_id === dispatch.id
  ) {
    settleTaskAfterLostWorker(db, dispatch.taskId, 'ready')
    return undefined
  }
  if (record.task_settled_here) {
    return undefined
  }
  if (state.removed || task.status === 'failed') {
    db.settleRemoteAttemptResult({
      taskId: dispatch.taskId,
      dispatchId: dispatch.id,
      outcome: 'failed',
      result: state.removed?.reason ?? task.result ?? dispatch.lastFailure ?? '',
      correctedUnobservedPrompt: !state.removed && state.correctedUnobservedPrompt
    })
  } else if (task.status === 'completed') {
    db.settleRemoteAttemptResult({
      taskId: dispatch.taskId,
      dispatchId: dispatch.id,
      outcome: 'succeeded',
      result: task.result ?? '',
      correctedUnobservedPrompt: state.correctedUnobservedPrompt
    })
  } else if (
    task.status === 'blocked' &&
    currentRemoteAttempt(db, dispatch.taskId)?.dispatch_id === dispatch.id
  ) {
    reconcileTaskAfterDispatchInterruption(db, dispatch.taskId, dispatch.id)
  }
  return undefined
}
