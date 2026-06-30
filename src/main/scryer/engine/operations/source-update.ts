import type { ScryModel } from '../model'
import type { ScryerOperationExecutor } from '../types'
import { success } from './operation-result'
import { cloneModel, plannedOrFailure, stringField, type RecordInput } from './structural-input'

function locationsFromInput(value: unknown): ScryModel['sourceMap'][string] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((entry): entry is RecordInput => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      pattern: String(entry.pattern ?? ''),
      ...(typeof entry.symbol === 'string' ? { symbol: entry.symbol } : {}),
      ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
      ...(typeof entry.endLine === 'number' ? { endLine: entry.endLine } : {}),
      ...(typeof entry.command === 'string' ? { command: entry.command } : {})
    }))
    .filter((entry) => entry.pattern.trim())
}

function sourcesFromInput(value: unknown): ScryModel['boundaries'][string] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((entry): entry is RecordInput => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      pattern: String(entry.pattern ?? ''),
      ...(typeof entry.comment === 'string' ? { comment: entry.comment } : {})
    }))
    .filter((entry) => entry.pattern.trim())
}

function applySourceUpdates(model: ScryModel, input: RecordInput): void {
  for (const item of Array.isArray(input.entries) ? input.entries : []) {
    const record = item as RecordInput
    const nodeId = stringField(record, 'node_id') ?? stringField(record, 'owner_id')
    if (nodeId) {
      const locations = locationsFromInput(record.locations ?? record.sources)
      if (locations.length > 0) {
        model.sourceMap[nodeId] = locations
      } else {
        delete model.sourceMap[nodeId]
      }
    }
  }
  for (const item of Array.isArray(input.schemas) ? input.schemas : []) {
    const record = item as RecordInput
    const nodeId = stringField(record, 'node_id')
    if (nodeId) {
      const locations = locationsFromInput(record.locations)
      if (locations.length > 0) {
        model.sourceMap[nodeId] = locations
      } else {
        delete model.sourceMap[nodeId]
      }
    }
  }
  for (const item of Array.isArray(input.boundaries) ? input.boundaries : []) {
    const record = item as RecordInput
    const nodeId = stringField(record, 'node_id')
    if (nodeId) {
      const sources = sourcesFromInput(record.sources)
      if (sources.length > 0) {
        model.boundaries[nodeId] = sources
      } else {
        delete model.boundaries[nodeId]
      }
    }
  }
}

export const sourceUpdateOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  input,
  state
}) => {
  const stateFailure = plannedOrFailure(state, 'scryer.source.update')
  if (stateFailure) {
    return stateFailure
  }
  const planned = cloneModel(state.planned!)
  const committed = state.committed ? cloneModel(state.committed) : undefined
  applySourceUpdates(planned, input)
  if (committed) {
    applySourceUpdates(committed, input)
  }
  return success({
    result: {
      updatedCount:
        (Array.isArray(input.entries) ? input.entries.length : 0) +
        (Array.isArray(input.schemas) ? input.schemas.length : 0) +
        (Array.isArray(input.boundaries) ? input.boundaries.length : 0)
    },
    changes: {
      planned,
      ...(committed ? { committed } : {})
    }
  })
}
