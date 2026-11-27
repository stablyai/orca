import {
  itsaplanIssueWebUrl,
  type ItsaplanComment,
  type ItsaplanIssue,
  type ItsaplanLabel,
  type ItsaplanMember,
  type ItsaplanProject,
  type ItsaplanProjectMetadata,
  type ItsaplanStateType
} from '../../shared/itsaplan/itsaplan-types'

// List and search hits omit description; get-issue includes it.
export type ItsaplanRawIssue = {
  id: number
  sequenceNumber: number
  identifier: string
  columnId: number
  assigneeUserId: string | null
  delegateUserId: string | null
  parentId: number | null
  title: string
  description?: string | null
  priority: string | null
  labelIds: number[]
  createdAt: string
  updatedAt: string
}

export type ItsaplanRawProject = { id: number; ref: string; key: string; name: string }
export type ItsaplanRawColumn = {
  id: number
  name: string
  stateType: string
  position: number
}
export type ItsaplanRawLabel = { id: number; name: string; color?: string | null }
// Project assignees: `kind` separates members from AI agents.
export type ItsaplanRawMember = { userId: string; name: string; kind?: string }
export type ItsaplanRawFeedItem = {
  id: number
  kind: string
  body: string | null
  actorUserId: string | null
  actorName: string | null
  createdAt: string
}

const STATE_TYPES: readonly ItsaplanStateType[] = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled'
]

function toStateType(value: string): ItsaplanStateType {
  return STATE_TYPES.find((stateType) => stateType === value) ?? 'unstarted'
}

export function mapItsaplanProjectMetadata(
  rawProject: ItsaplanRawProject,
  rawColumns: ItsaplanRawColumn[],
  rawLabels: ItsaplanRawLabel[],
  rawMembers: ItsaplanRawMember[]
): ItsaplanProjectMetadata {
  const project: ItsaplanProject = {
    id: rawProject.id,
    ref: rawProject.ref,
    key: rawProject.key,
    name: rawProject.name
  }
  return {
    project,
    columns: rawColumns.map((column) => ({
      id: column.id,
      name: column.name,
      stateType: toStateType(column.stateType),
      position: column.position
    })),
    labels: rawLabels.map((label) => ({
      id: label.id,
      name: label.name,
      color: label.color || null
    })),
    members: rawMembers.map((member) => ({
      userId: member.userId,
      name: member.name,
      isAgent: member.kind === 'agent'
    }))
  }
}

function resolveMember(userId: string | null, members: ItsaplanMember[]): ItsaplanMember | null {
  if (!userId) {
    return null
  }
  return (
    members.find((member) => member.userId === userId) ?? {
      userId,
      name: userId,
      isAgent: false
    }
  )
}

export function mapItsaplanIssue(
  raw: ItsaplanRawIssue,
  ctx: { metadata: ItsaplanProjectMetadata; appUrl: string }
): ItsaplanIssue {
  const { metadata } = ctx
  const column = metadata.columns.find((candidate) => candidate.id === raw.columnId)
  const labels = raw.labelIds
    .map((labelId) => metadata.labels.find((label) => label.id === labelId))
    .filter((label): label is ItsaplanLabel => label !== undefined)
  return {
    id: raw.id,
    identifier: raw.identifier,
    sequenceNumber: raw.sequenceNumber,
    projectRef: metadata.project.ref,
    title: raw.title,
    description: raw.description ?? '',
    priority: raw.priority ?? null,
    state: column
      ? { columnId: column.id, name: column.name, stateType: column.stateType }
      : { columnId: raw.columnId, name: 'Unknown', stateType: 'unstarted' },
    labels,
    assignee: resolveMember(raw.assigneeUserId, metadata.members),
    delegate: resolveMember(raw.delegateUserId, metadata.members),
    parentId: raw.parentId ?? null,
    url: itsaplanIssueWebUrl(ctx.appUrl, raw.id),
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt
  }
}

export function mapItsaplanComment(item: ItsaplanRawFeedItem): ItsaplanComment | null {
  if (item.kind !== 'comment' || item.body === null) {
    return null
  }
  return {
    id: item.id,
    body: item.body,
    author: item.actorUserId
      ? { userId: item.actorUserId, name: item.actorName ?? item.actorUserId }
      : null,
    createdAt: item.createdAt
  }
}
