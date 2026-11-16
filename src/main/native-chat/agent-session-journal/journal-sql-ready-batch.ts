import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlRequest } from './journal-sql-protocol'

const MAX_STEPS = 64
const MAX_BYTES = 1024 * 1024

/** Sender work only: classification never opens a saved projection. */
export function prepareJournalSqlRequest(
  id: number,
  command: JournalSqlRequest['command']
): JournalSqlRequest {
  let batch: JournalSqlRequest['batch']
  if (command.type === 'write' && !command.command.effects) {
    const { operation } = command.command
    if (
      operation.kind === 'steps' &&
      operation.steps.length > 0 &&
      operation.steps.every(
        (step) =>
          step.kind === 'resolved-item' &&
          step.resolution.kind === 'text-snapshot' &&
          streamingText(step.resolution.body)
      )
    ) {
      batch = {
        sessionId: command.command.target.sessionId,
        steps: operation.steps.length,
        // Admission already reserved identity/body bytes; only size the remaining envelope.
        bytes:
          operation.steps.reduce((total, step) => total + step.reservedBytes, 0) +
          Buffer.byteLength(
            JSON.stringify({
              ...command.command,
              operation: {
                ...operation,
                steps: operation.steps.map((step) =>
                  step.kind === 'resolved-item' && step.resolution.kind === 'text-snapshot'
                    ? {
                        ...step,
                        resolution: { ...step.resolution, body: null, identity: null }
                      }
                    : step
                )
              }
            }),
            'utf8'
          )
      }
    }
  }
  return { id, command, ...(batch ? { batch } : {}) }
}

/** Controls, repeated chats and an oversized atomic command keep their own boundary. */
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

function streamingText(body: AgentJournalMessageItem): boolean {
  return (
    (body.role === 'assistant' || body.role === 'reasoning') &&
    body.completedAt === undefined &&
    body.state === undefined &&
    body.blocks.every((block) => block.type === 'text')
  )
}
