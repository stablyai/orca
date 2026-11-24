import type { JournalWriterStep } from './writing/journal-writer-step'
import type { JournalSqlRequest } from './journal-sql-protocol'

const MAX_STEPS = 64
/** A sending chat's write waits for the bulk transaction in progress, so none outgrows one large tool output. */
const MAX_BYTES = 256 * 1024

/** Sender work only: sizing reads each step's admission reservation, never its body. */
export function prepareJournalSqlRequest(
  id: number,
  command: JournalSqlRequest['command']
): JournalSqlRequest {
  let batch: JournalSqlRequest['batch']
  // Receipts and fork installs keep their own transaction (a fork install raises it to FULL sync).
  if (command.type === 'write' && !command.command.effects && !command.command.forkInstall) {
    const { operation } = command.command
    if (
      operation.kind === 'steps' &&
      operation.steps.length > 0 &&
      operation.steps.every(itemStep)
    ) {
      batch = {
        sessionId: command.command.target.sessionId,
        steps: operation.steps.length,
        // Bodies are reserved at admission; only the envelope (target, host facts) is measured.
        bytes:
          operation.steps.reduce((total, step) => total + step.reservedBytes, 0) +
          Buffer.byteLength(
            JSON.stringify({ ...command.command, operation: { ...operation, steps: [] } }),
            'utf8'
          )
      }
    }
  }
  const urgent = command.type === 'write' && command.command.urgent === true
  return { id, command, ...(batch ? { batch } : {}), ...(urgent ? { urgent } : {}) }
}

/** Controls, repeated chats, an oversized atomic command and the urgent/bulk divide keep their own boundary. */
export function takeJournalSqlReadyBatch(queue: JournalSqlRequest[]): JournalSqlRequest[] {
  const first = queue[0]
  if (!first?.batch) {
    return queue.splice(0, 1)
  }
  const sessions = new Set<string>()
  let count = 0
  let steps = 0
  let bytes = 0
  for (const request of queue) {
    const next = request.batch
    if (
      !next ||
      request.command.type !== first.command.type ||
      request.urgent !== first.urgent ||
      (count > 0 &&
        (sessions.has(next.sessionId) ||
          steps + next.steps > MAX_STEPS ||
          bytes + next.bytes > MAX_BYTES))
    ) {
      break
    }
    count++
    steps += next.steps
    bytes += next.bytes
    sessions.add(next.sessionId)
    if (steps >= MAX_STEPS || bytes >= MAX_BYTES) {
      break
    }
  }
  return queue.splice(0, count)
}

/** Settlements check their permit before COMMIT and lifecycle steps settle turns, so both commit alone. */
function itemStep(step: JournalWriterStep): boolean {
  return step.kind === 'item' || step.kind === 'creation-fact' || step.kind === 'resolved-item'
}
