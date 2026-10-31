import type { AgentJournalRenderItem } from '../../shared/agent-session-journal-types'
import { readCodexJournalRecord } from './codex-structured-journal-translation-values'

export function savedTurnFacts(saved: AgentJournalRenderItem | null): Record<string, unknown> {
  const body = saved?.body
  return body?.kind !== 'turn'
    ? {}
    : {
        ...(body.outcome
          ? {
              status: { success: 'completed', failure: 'failed', cancellation: 'interrupted' }[
                body.outcome
              ]
            }
          : body.state === 'interrupted'
            ? { status: 'interrupted' }
            : {}),
        ...(body.startedAt !== undefined ? { startedAt: body.startedAt / 1000 } : {}),
        ...(body.completedAt !== undefined ? { completedAt: body.completedAt / 1000 } : {}),
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {})
      }
}

/** Count newly retained semantics/metadata; an existing saved payload remains journal-owned. */
export function retainedSize(value: unknown, saved: AgentJournalRenderItem | null): number {
  const body = saved?.body
  const borrowed =
    body?.kind === 'tool-call' && body.output && !body.output.truncated
      ? body.output.head
      : undefined
  const savedValues = new Set<unknown>()
  if (body?.kind === 'tool-call') {
    savedValues.add(body.input)
    for (const value of Object.values(readCodexJournalRecord(body.input))) {
      savedValues.add(value)
    }
  } else if (body?.kind === 'message') {
    for (const block of body.blocks) {
      if (block.type === 'text') {
        savedValues.add(block.text)
      }
      if (block.type === 'image-ref') {
        savedValues.add(block.path)
        savedValues.add(block.url)
      }
    }
  }
  const measure = (entry: unknown): number => {
    if (entry === undefined) {
      return 0
    }
    if (entry === borrowed && borrowed !== undefined) {
      return 8
    }
    if (savedValues.has(entry)) {
      return 8
    }
    if (entry === null || typeof entry !== 'object') {
      return Buffer.byteLength(JSON.stringify(entry), 'utf8')
    }
    if (Array.isArray(entry)) {
      return 2 + entry.reduce((sum, part) => sum + measure(part) + 1, 0)
    }
    return (
      2 +
      Object.entries(entry).reduce(
        (sum, [key, part]) => sum + Buffer.byteLength(JSON.stringify(key)) + 2 + measure(part),
        0
      )
    )
  }
  return measure(value)
}
