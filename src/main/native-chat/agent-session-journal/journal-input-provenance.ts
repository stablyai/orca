import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalQueueRebaseWithAcceptance } from './journal-queue-rebase'
export {
  journalQueueRebaseWithAcceptance,
  prepareJournalQueueRebaseWithAcceptance
} from './journal-queue-rebase'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order-owner'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { readCommandReceipt } from './command-receipt-table'
import type { CommandReceiptRead } from './command-receipt-table'
import type { JournalReadConnection } from './journal-sql-owner'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'

/** Only the original send's accepted coordinate can compare a retired enqueue boundary. */
export function journalInputAcceptance(
  db: Database.Database,
  sessionId: string,
  id: string
): AgentJournalCursor | undefined {
  const read = readCommandReceipt(db, { kind: 'global' }, id)
  return journalAcceptedInput(read, sessionId)
}

function journalAcceptedInput(
  read: CommandReceiptRead,
  sessionId: string
): AgentJournalCursor | undefined {
  if (
    read.verdict === 'readable' &&
    read.receipt.status === 'accepted' &&
    read.receipt.sessionId === sessionId &&
    read.receipt.method === 'agentSession.send' &&
    read.receipt.result.kind === 'journal-row'
  ) {
    return { epoch: read.receipt.result.epoch, sequence: read.receipt.result.sequence }
  }
  return undefined
}

/** Request-local facts; a later receipt phase must obtain its own view. */
export async function prepareJournalAcceptance(
  read: Pick<JournalReadConnection, 'receipts'>,
  sessionId: string,
  ids: readonly string[]
): Promise<(id: string) => AgentJournalCursor | undefined> {
  function* uniqueIds(): Generator<void, string[]> {
    const unique = new Set<string>()
    const values: string[] = []
    for (const id of ids) {
      if (!unique.has(id)) {
        unique.add(id)
        values.push(id)
      }
      yield
    }
    return values
  }
  const receipts = await read.receipts(
    { kind: 'global' },
    await finishJournalStepsAsync(uniqueIds())
  )
  return (id) => {
    const receipt = receipts.get(id)
    if (!receipt) {
      throw new Error('journal provenance was not prepared for this action')
    }
    return journalAcceptedInput(receipt, sessionId)
  }
}

/** Reuse comparable admission coordinates; original receipts remain the provenance authority. */
export function journalQueueRebase(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  previousEpoch: string | undefined,
  queued: readonly AgentJournalSubmission[],
  rebuilt: ReadonlyMap<string, number>
): (queuedAt: AgentJournalCursor | null) => AgentJournalCursor | null {
  return journalQueueRebaseWithAcceptance(
    (id) => journalInputAcceptance(db, sessionId, id),
    epoch,
    previousEpoch,
    queued,
    rebuilt
  )
}

/** Resolve demanded legacy admission facts at the action's publication boundary. */
export async function withJournalInputOrder<T>(
  database: JournalHostDatabase,
  state: () => JournalReducerState,
  ids: () => readonly string[],
  action: () => T
): Promise<T> {
  if (journalInputOrder(state()).needsAcceptance(ids()).length === 0) {
    return action()
  }
  return database.transaction(async (plan) => {
    const current = state()
    const order = journalInputOrder(current)
    const acceptance = await prepareJournalAcceptance(
      plan,
      current.sessionId,
      order.needsAcceptance(ids())
    )
    return order.withAcceptance(acceptance, action)
  })
}
