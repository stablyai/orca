import type { PlaneIssueUpdate } from '../../shared/plane/types'
import type { PlaneListFilter } from '../plane/issues'

const VALID_FILTERS = new Set<PlaneListFilter>(['assigned', 'created', 'all', 'completed', 'open'])
const MIN_LIMIT = 1
const MAX_LIMIT = 50

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function requiredString(value: unknown, message: string): string {
  const normalized = optionalString(value)
  if (!normalized) {
    throw new Error(message)
  }
  return normalized
}

export function optionalLimit(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(MIN_LIMIT, Math.trunc(value)), MAX_LIMIT)
    : fallback
}

export function normalizeFilter(value: unknown): PlaneListFilter | undefined {
  return VALID_FILTERS.has(value as PlaneListFilter) ? (value as PlaneListFilter) : undefined
}

export function normalizeCreateArgs(args: Record<string, unknown>) {
  return {
    projectId: requiredString(args.projectId, 'Plane project ID is required'),
    title: requiredString(args.title, 'Title is required'),
    description: optionalString(args.description),
    stateId: optionalString(args.stateId),
    priority: optionalString(args.priority),
    assigneeIds: optionalStringList(args.assigneeIds, 'assignee IDs'),
    labelIds: optionalStringList(args.labelIds, 'label IDs'),
    cycleId: optionalString(args.cycleId),
    estimatePoint: optionalEstimatePointValue(args.estimatePoint),
    typeId: optionalString(args.typeId),
    moduleId: optionalString(args.moduleId),
    externalSource: optionalString(args.externalSource),
    externalId: optionalString(args.externalId),
    instanceId: optionalString(args.instanceId)
  }
}

export function normalizeUpdates(value: unknown): PlaneIssueUpdate {
  if (!value || typeof value !== 'object') {
    throw new Error('Updates object is required')
  }
  const raw = value as Record<string, unknown>
  return {
    ...(raw.title !== undefined ? { title: requiredString(raw.title, 'Title is required') } : {}),
    ...(raw.description !== undefined
      ? { description: optionalNullableString(raw.description, 'description') }
      : {}),
    ...(raw.stateId !== undefined
      ? { stateId: raw.stateId === null ? null : requiredString(raw.stateId, 'Invalid state ID') }
      : {}),
    ...(raw.priority !== undefined
      ? {
          priority: raw.priority === null ? null : requiredString(raw.priority, 'Invalid priority')
        }
      : {}),
    ...(raw.cycleId !== undefined
      ? { cycleId: raw.cycleId === null ? null : requiredString(raw.cycleId, 'Invalid cycle ID') }
      : {}),
    ...(raw.estimatePoint !== undefined
      ? {
          estimatePoint:
            raw.estimatePoint === null ? null : nullableEstimatePointValue(raw.estimatePoint)
        }
      : {}),
    ...(raw.typeId !== undefined
      ? { typeId: raw.typeId === null ? null : requiredString(raw.typeId, 'Invalid type ID') }
      : {}),
    ...(raw.moduleId !== undefined
      ? {
          moduleId: raw.moduleId === null ? null : requiredString(raw.moduleId, 'Invalid module ID')
        }
      : {}),
    ...(raw.assigneeIds !== undefined
      ? { assigneeIds: optionalStringList(raw.assigneeIds, 'assignee IDs') }
      : {}),
    ...(raw.labelIds !== undefined
      ? { labelIds: optionalStringList(raw.labelIds, 'label IDs') }
      : {})
  }
}

function optionalStringList(value: unknown, fieldName: string): string[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value.map((item) => item.trim())
}

function optionalNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${fieldName}`)
  }
  return value
}

function optionalEstimatePointValue(value: unknown): string | number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim()
    const numeric = Number(normalized)
    return Number.isFinite(numeric) ? numeric : normalized
  }
  throw new Error('Invalid estimate point value')
}

function nullableEstimatePointValue(value: unknown): string | number | null {
  if (value === null) {
    return null
  }
  const normalized = optionalEstimatePointValue(value)
  if (normalized === undefined) {
    throw new Error('Invalid estimate point value')
  }
  return normalized
}
