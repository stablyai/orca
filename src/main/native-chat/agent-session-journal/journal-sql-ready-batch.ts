import type { JournalSqlRequest } from './journal-sql-protocol'
import type { JournalWriterCommand } from './journal-writer-command'
import { journalSqlMaintenanceIsNormal } from './journal-sql-maintenance'

const MAX_EVENTS = 64
const MAX_BYTES = 1024 * 1024

/** Control commands keep their own boundary; an oversized atomic command runs alone. */
export function takeJournalSqlReadyBatch(
  queue: JournalSqlRequest[],
  streamed: (command: JournalWriterCommand) => boolean
): { request: JournalSqlRequest; normal: boolean }[] {
  const batch: { request: JournalSqlRequest; normal: boolean }[] = []
  let events = 0
  let bytes = 0
  for (const request of queue) {
    const { command } = request
    const normal = command.type === 'write' && streamed(command.command)
    if (!normal) {
      if (batch.length === 0) {
        batch.push({
          request,
          normal: command.type === 'maintenance' && journalSqlMaintenanceIsNormal(command.operation)
        })
      }
      break
    }
    const count =
      command.command.operation.kind === 'steps'
        ? Math.max(1, command.command.operation.steps.length)
        : 1
    let size: number
    try {
      size = Buffer.byteLength(JSON.stringify(command.command), 'utf8')
    } catch {
      if (batch.length === 0) {
        batch.push({ request, normal: false })
      }
      break
    }
    if (batch.length > 0 && (events + count > MAX_EVENTS || bytes + size > MAX_BYTES)) {
      break
    }
    batch.push({ request, normal: true })
    events += count
    bytes += size
    if (events >= MAX_EVENTS || bytes >= MAX_BYTES) {
      break
    }
  }
  queue.splice(0, batch.length)
  return batch
}
