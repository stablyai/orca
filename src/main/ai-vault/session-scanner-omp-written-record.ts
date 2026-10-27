import { asRecord, extractString } from './session-scanner-values'

// OMP inherits PI_CODING_AGENT_DIR, so Pi's folder can hold OMP transcripts; Pi never writes these.
export function isOmpWrittenRecord(record: Record<string, unknown>): boolean {
  return (
    (record.type === 'title' && record.v === 1) ||
    asRecord(record.runtime) !== null ||
    (record.type === 'model_change' &&
      record.modelId === undefined &&
      extractString(record.model) !== null)
  )
}
