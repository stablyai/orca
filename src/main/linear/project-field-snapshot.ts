import type { LinearClient } from '@linear/sdk'
import type {
  LinearProjectFieldSnapshot,
  LinearProjectLabelRef,
  LinearProjectRef,
  LinearProjectTeamRef,
  LinearProjectUserRef
} from '../../shared/linear/project-agent-access'
import type { LinearClientForWorkspace } from './client'
import {
  boundedLinearEntityCollection,
  boundedLinearNullableString,
  boundedLinearString,
  normalizeLinearLineEndings
} from './linear-text-digest'
import { readProjectConnectionRows } from './project-connection-pages'
import {
  mapLinearProjectLabelRef,
  mapLinearProjectTeamRef,
  mapLinearProjectUserRef,
  toLinearProjectStatusType
} from './project-reference-mapping'
import {
  PROJECT_SHOW_QUERY,
  type ProjectShowNode,
  type ProjectShowResponse
} from './project-show-query'

/**
 * Host-internal view of a project: complete LF-normalized text and complete
 * entity arrays, never capped. No-op detection and read-back verification
 * compare against this; only the RPC projection is bounded.
 */
export type LinearProjectInternalSnapshot = Omit<
  LinearProjectFieldSnapshot,
  'description' | 'content' | 'members' | 'teams' | 'labels'
> & {
  description: string
  content: string | null
  members: LinearProjectUserRef[]
  teams: LinearProjectTeamRef[]
  labels: LinearProjectLabelRef[]
}

export type LinearProjectWriteRecord = {
  project: LinearProjectRef
  fields: LinearProjectInternalSnapshot
}

/** Raw project read on a caller-owned client, so writes can confirm without a nested acquire. */
export async function readProjectSnapshotNode(
  client: LinearClient,
  projectId: string
): Promise<ProjectShowNode | null> {
  const result = await client.client.rawRequest<ProjectShowResponse, Record<string, unknown>>(
    PROJECT_SHOW_QUERY,
    { id: projectId }
  )
  return result.data?.project ?? null
}

/** Follows every member/team/label cursor: a first page cannot verify a replacement write. */
export async function completeProjectWriteRecord(
  entry: LinearClientForWorkspace,
  node: ProjectShowNode,
  signal?: AbortSignal
): Promise<LinearProjectWriteRecord> {
  const [members, teams, labels] = await Promise.all([
    readProjectConnectionRows({
      entry,
      projectId: node.id,
      field: 'members',
      initial: node.members,
      map: mapLinearProjectUserRef,
      signal
    }),
    readProjectConnectionRows({
      entry,
      projectId: node.id,
      field: 'teams',
      initial: node.teams,
      map: mapLinearProjectTeamRef,
      signal
    }),
    readProjectConnectionRows({
      entry,
      projectId: node.id,
      field: 'labels',
      initial: node.labels,
      map: mapLinearProjectLabelRef,
      signal
    })
  ])

  return {
    project: {
      id: node.id,
      name: node.name ?? '',
      slugId: node.slugId ?? '',
      url: node.url ?? ''
    },
    fields: {
      name: node.name ?? '',
      description: normalizeLinearLineEndings(node.description ?? ''),
      // Why: absent content stays null so it never compares equal to an empty document.
      content: node.content == null ? null : normalizeLinearLineEndings(node.content),
      status: {
        id: node.status?.id ?? '',
        name: node.status?.name ?? '',
        type: toLinearProjectStatusType(node.status?.type),
        color: node.status?.color ?? ''
      },
      lead: node.lead ? mapLinearProjectUserRef(node.lead) : null,
      members,
      teams,
      labels,
      priority: node.priority ?? 0,
      startDate: node.startDate ?? null,
      targetDate: node.targetDate ?? null,
      color: node.color ?? '',
      icon: node.icon ?? null
    }
  }
}

/** Internal snapshot → the published bounded string/digest shapes. */
export function toLinearProjectFieldSnapshot(
  fields: LinearProjectInternalSnapshot
): LinearProjectFieldSnapshot {
  return {
    name: fields.name,
    description: boundedLinearString(fields.description),
    content: boundedLinearNullableString(fields.content),
    status: fields.status,
    lead: fields.lead,
    members: boundedLinearEntityCollection(fields.members),
    teams: boundedLinearEntityCollection(fields.teams),
    labels: boundedLinearEntityCollection(fields.labels),
    priority: fields.priority,
    startDate: fields.startDate,
    targetDate: fields.targetDate,
    color: fields.color,
    icon: fields.icon
  }
}

export function linearProjectEntityIds(items: readonly { id: string }[]): string[] {
  return items.map((item) => item.id)
}

/** Collection equality is set equality by id; order and duplicates carry no intent. */
export function sameLinearProjectIdSet(left: readonly string[], right: readonly string[]): boolean {
  const source = new Set(left)
  const target = new Set(right)
  return source.size === target.size && [...source].every((id) => target.has(id))
}

/** Text intent compares LF-normalized; null and empty text stay distinct. */
export function sameLinearProjectText(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return left === right
  }
  return normalizeLinearLineEndings(left) === normalizeLinearLineEndings(right)
}
