import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'

/**
 * What the last durable write of one pane's binding contained.
 *
 * `session` is the object identity the binding was written into. Every session-replacing writer
 * (`setWorkspaceSession`, `patchWorkspaceSession`) installs a fresh object, so an identity
 * mismatch retires the record without those writers knowing this map exists. The two in-place
 * binding writers are covered by the value fields instead: SSH lease cleanup only clears bindings,
 * and SSH target migration rewrites the PTY id, so neither can leave a stale record matching a
 * request. See the writer audit in orca-persistence-design-assessment.md.
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
