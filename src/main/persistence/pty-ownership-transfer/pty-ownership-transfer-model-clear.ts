import { parsePtyOwnershipModelPayload } from './pty-ownership-transfer-model-payload'
import type { PtyOwnershipTransferOutputOutboxRecord } from './pty-ownership-transfer-destination-output-outbox-record'

type ModelPayload = ReturnType<typeof parsePtyOwnershipModelPayload>
export type PtyOwnershipModelClear = {
  operationIds: string[]
  throughSeq: number
  modelSequenceEnd: number
  model: ModelPayload
}
export type PtyOwnershipModelClearRequest = {
  operationId: string
  expectedRevision: number
  throughSeq: number
  modelSequenceEnd: number
  model: ModelPayload
}
export const MAX_PTY_OWNERSHIP_MODEL_CLEAR_OPERATIONS = 4096

export function restorablePtyOwnershipModel(record: PtyOwnershipTransferOutputOutboxRecord) {
  const saved = record.modelSnapshot ?? record.initialModelSnapshot
  const clear = record.modelClear
  if (!saved || !clear) {
    return saved ?? null
  }
  const sequence =
    'checkpoint' in saved ? saved.checkpoint.modelSequenceEnd : saved.modelSequenceEnd
  return sequence === clear.modelSequenceEnd ? { ...saved, ...clear.model } : saved
}

function operationId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new Error('pty_ownership_transfer_model_clear_operation_invalid')
  }
  return value
}

function boundary(record: PtyOwnershipTransferOutputOutboxRecord) {
  const saved = record.modelSnapshot
  const initial = record.initialModelSnapshot
  const model = saved ?? initial
  if (!model?.restoreMetadata) {
    throw new Error('pty_ownership_transfer_model_clear_restore_required')
  }
  return {
    throughSeq: saved?.checkpoint.frameSeq ?? initial!.throughSeq,
    modelSequenceEnd: saved?.checkpoint.modelSequenceEnd ?? initial!.modelSequenceEnd,
    complete: !saved || saved.checkpoint.fragmentEndSu === saved.checkpoint.frameLengthSu
  }
}

export function parsePtyOwnershipModelClear(
  value: unknown,
  record: PtyOwnershipTransferOutputOutboxRecord
): PtyOwnershipModelClear {
  const candidate = value as Partial<PtyOwnershipModelClear> | null
  if (
    !candidate ||
    !Array.isArray(candidate.operationIds) ||
    !candidate.operationIds.length ||
    candidate.operationIds.length > MAX_PTY_OWNERSHIP_MODEL_CLEAR_OPERATIONS ||
    !Number.isSafeInteger(candidate.throughSeq) ||
    !Number.isSafeInteger(candidate.modelSequenceEnd)
  ) {
    throw new Error('pty_ownership_transfer_model_clear_invalid')
  }
  const operationIds = candidate.operationIds.map(operationId)
  const throughSeq = Number(candidate.throughSeq)
  const modelSequenceEnd = Number(candidate.modelSequenceEnd)
  const current = boundary(record)
  const model = parsePtyOwnershipModelPayload(candidate.model, { allowEmpty: true })
  if (
    new Set(operationIds).size !== operationIds.length ||
    !model.restoreMetadata ||
    throughSeq < record.baseEndSeq ||
    throughSeq > record.acknowledgedEndSeq ||
    modelSequenceEnd < 0 ||
    modelSequenceEnd > current.modelSequenceEnd ||
    throughSeq > current.throughSeq ||
    (throughSeq === current.throughSeq
      ? modelSequenceEnd !== current.modelSequenceEnd || !current.complete
      : modelSequenceEnd >= current.modelSequenceEnd)
  ) {
    throw new Error('pty_ownership_transfer_model_clear_cursor_invalid')
  }
  return { operationIds, throughSeq, modelSequenceEnd, model }
}

/** Clear is model-only: neither the capture receipt nor any output cursor is rewritten. */
export function recordPtyOwnershipModelClear(
  record: PtyOwnershipTransferOutputOutboxRecord,
  request: PtyOwnershipModelClearRequest
): boolean {
  const id = operationId(request.operationId)
  if (record.modelClear?.operationIds.includes(id)) {
    return false
  }
  const current = boundary(record)
  if (
    !current.complete ||
    current.throughSeq !== record.acknowledgedEndSeq ||
    request.throughSeq !== current.throughSeq ||
    request.modelSequenceEnd !== current.modelSequenceEnd ||
    request.expectedRevision !== (record.modelClear?.operationIds.length ?? 0)
  ) {
    throw new Error('pty_ownership_transfer_model_clear_boundary_changed')
  }
  record.modelClear = parsePtyOwnershipModelClear(
    {
      operationIds: [...(record.modelClear?.operationIds ?? []), id],
      throughSeq: current.throughSeq,
      modelSequenceEnd: current.modelSequenceEnd,
      model: request.model
    },
    record
  )
  record.version = 5
  return true
}
