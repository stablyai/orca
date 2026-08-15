import type { PlaneClientForInstance } from './client'
import {
  mapMember,
  notNull,
  record,
  stringField,
  numberField,
  booleanField
} from './response-mappers'
import type {
  PlaneCycle,
  PlaneEstimate,
  PlaneEstimatePoint,
  PlaneModule,
  PlaneWorkItemType
} from '../../shared/plane/types'

type PlaneClient = PlaneClientForInstance

export function mapCycle(
  client: PlaneClient,
  projectId: string,
  input: unknown
): PlaneCycle | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        startDate: stringField(raw, 'start_date'),
        endDate: stringField(raw, 'end_date'),
        status: stringField(raw, 'status'),
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapModule(
  client: PlaneClient,
  projectId: string,
  input: unknown
): PlaneModule | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        startDate: stringField(raw, 'start_date'),
        targetDate: stringField(raw, 'target_date'),
        status: stringField(raw, 'status'),
        lead: mapMember(raw.lead ?? raw.module_lead),
        members: Array.isArray(raw.members) ? raw.members.map(mapMember).filter(notNull) : [],
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapWorkItemType(
  client: PlaneClient,
  projectId: string,
  input: unknown
): PlaneWorkItemType | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        isDefault: booleanField(raw, 'is_default'),
        isActive: booleanField(raw, 'is_active'),
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

export function mapEstimate(
  client: PlaneClient,
  projectId: string,
  input: unknown
): PlaneEstimate | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  const name = stringField(raw, 'name')
  return id && name
    ? {
        id,
        name,
        description: stringField(raw, 'description'),
        points: Array.isArray(raw.points)
          ? raw.points.map(mapEstimatePoint).filter(notNull)
          : undefined,
        projectId,
        workspaceSlug: client.instance.workspaceSlug,
        instanceId: client.instance.id
      }
    : null
}

function mapEstimatePoint(input: unknown): PlaneEstimatePoint | null {
  const raw = record(input)
  const id = stringField(raw, 'id')
  return id
    ? {
        id,
        key: stringField(raw, 'key'),
        value: stringField(raw, 'value') ?? numberField(raw, 'value'),
        description: stringField(raw, 'description')
      }
    : null
}
