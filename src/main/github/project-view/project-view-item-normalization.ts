import type {
  GitHubProjectFieldValue,
  GitHubProjectLabel,
  GitHubProjectRow,
  GitHubProjectRowItemType,
  GitHubProjectUser
} from '../../../shared/github/project-types'
import type { GitHubProjectViewError } from '../../../shared/github/project-result-types'
import { driftError } from './project-error-classification'
import {
  normalizeFieldValue,
  normalizeLabel,
  normalizeUser,
  type RawFieldValue,
  type RawLabel,
  type RawUser
} from './project-view-field-normalization'

type RawContent = {
  __typename?: string
  id?: string
  number?: number
  title?: string
  body?: string
  url?: string
  state?: string
  stateReason?: string | null
  isDraft?: boolean
  repository?: { nameWithOwner?: string }
  assignees?: { nodes?: RawUser[] }
  labels?: { nodes?: RawLabel[] }
  parent?: { number?: number; title?: string; url?: string } | null
  issueType?: {
    id?: string
    name?: string
    color?: string | null
    description?: string | null
  } | null
}

export type RawItem = {
  id?: string
  type?: string
  updatedAt?: string
  content?: RawContent | null
  fieldValues?: {
    nodes?: RawFieldValue[]
    pageInfo?: { hasNextPage?: boolean }
  }
}

type NormalizedItemOutcome =
  | { ok: true; row: GitHubProjectRow }
  | { ok: false; drift: GitHubProjectViewError }

function mapItemType(raw: string | undefined, hasContent: boolean): GitHubProjectRowItemType {
  if (raw === 'ISSUE') {
    return 'ISSUE'
  }
  if (raw === 'PULL_REQUEST') {
    return 'PULL_REQUEST'
  }
  if (raw === 'DRAFT_ISSUE') {
    return 'DRAFT_ISSUE'
  }
  if (raw === 'REDACTED' || !hasContent) {
    return 'REDACTED'
  }
  // Unknown item type with content — treat as redacted rather than dropping.
  return 'REDACTED'
}

export function normalizeItem(raw: RawItem, position: number): NormalizedItemOutcome {
  if (!raw || typeof raw.id !== 'string') {
    return {
      ok: false,
      drift: driftError('item missing id', { path: ['items', 'nodes', position, 'id'] })
    }
  }
  if (raw.fieldValues?.pageInfo?.hasNextPage === true) {
    return {
      ok: false,
      drift: driftError('item field values exceeded single page', {
        path: ['items', 'nodes', position, 'fieldValues', 'pageInfo', 'hasNextPage']
      })
    }
  }
  const itemType = mapItemType(raw.type, raw.content !== null && raw.content !== undefined)
  const content = raw.content ?? null
  const assignees = (content?.assignees?.nodes ?? [])
    .map(normalizeUser)
    .filter((u): u is GitHubProjectUser => u !== null)
  const labels = (content?.labels?.nodes ?? [])
    .map(normalizeLabel)
    .filter((l): l is GitHubProjectLabel => l !== null)
  const parentIssue =
    content?.parent &&
    typeof content.parent.number === 'number' &&
    typeof content.parent.title === 'string' &&
    typeof content.parent.url === 'string'
      ? { number: content.parent.number, title: content.parent.title, url: content.parent.url }
      : null
  const issueType =
    content?.issueType &&
    typeof content.issueType.id === 'string' &&
    typeof content.issueType.name === 'string'
      ? {
          id: content.issueType.id,
          name: content.issueType.name,
          color: typeof content.issueType.color === 'string' ? content.issueType.color : null,
          description:
            typeof content.issueType.description === 'string' ? content.issueType.description : null
        }
      : null
  const fieldValuesByFieldId: Record<string, GitHubProjectFieldValue> = {}
  for (const fv of raw.fieldValues?.nodes ?? []) {
    const normalized = normalizeFieldValue(fv)
    if (normalized) {
      fieldValuesByFieldId[normalized.fieldId] = normalized
    }
  }
  const title =
    itemType === 'REDACTED'
      ? 'Restricted item'
      : typeof content?.title === 'string'
        ? content.title
        : ''
  const row: GitHubProjectRow = {
    id: raw.id,
    itemType,
    content: {
      number: typeof content?.number === 'number' ? content.number : null,
      title,
      body: typeof content?.body === 'string' ? content.body : null,
      url: typeof content?.url === 'string' ? content.url : null,
      state: typeof content?.state === 'string' ? content.state : null,
      stateReason: typeof content?.stateReason === 'string' ? content.stateReason : null,
      isDraft: typeof content?.isDraft === 'boolean' ? content.isDraft : null,
      repository:
        typeof content?.repository?.nameWithOwner === 'string'
          ? content.repository.nameWithOwner
          : null,
      assignees,
      labels,
      parentIssue,
      issueType
    },
    fieldValuesByFieldId,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    position
  }
  return { ok: true, row }
}
