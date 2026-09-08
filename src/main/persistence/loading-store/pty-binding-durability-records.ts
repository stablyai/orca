import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * Tracks the last durable binding. Session identity detects whole-session replacements, while the
 * binding fields detect in-place updates.
 */
type DurableBindingRecord = {
  readonly session: WorkspaceSessionState
  readonly ptyId: string
  readonly incarnationId: string | undefined
  readonly generation: number
}

export type DurableBindingRecords = Map<string, DurableBindingRecord>

/** Pane keys accumulate across a long session; a full clear is cheaper than tracking recency. */
const MAX_DURABLE_BINDING_RECORDS = 4096

export function recordDurableBinding(
  records: DurableBindingRecords,
  paneKey: string,
  record: DurableBindingRecord
): void {
  if (records.size >= MAX_DURABLE_BINDING_RECORDS && !records.has(paneKey)) {
    records.clear()
  }
  records.set(paneKey, record)
}

/**
 * Whether this exact binding is already on disk. The global write generation cannot answer that:
 * any unrelated dirty state holds it below the current generation, and a workspace switch dirties
 * unrelated state constantly, so a binding untouched for minutes would still look unpersisted.
 */
export function isBindingDurable(
  records: DurableBindingRecords,
  paneKey: string,
  session: WorkspaceSessionState,
  ptyId: string,
  incarnationId: string | undefined,
  lastDurableWriteGeneration: number
): boolean {
  const record = records.get(paneKey)
  return (
    record !== undefined &&
    record.session === session &&
    record.ptyId === ptyId &&
    record.incarnationId === incarnationId &&
    record.generation <= lastDurableWriteGeneration
  )
}
