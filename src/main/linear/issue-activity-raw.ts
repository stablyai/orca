import type {
  LinearIssueActivityEntry,
  LinearIssueActivityValue
} from '../../shared/linear-issue-activity'
import type { RawNamedEntity, RawPageInfo, RawUser } from './issue-context-raw'

type RawActivityEntity = RawNamedEntity & {
  identifier?: string | null
  title?: string | null
  url?: string | null
}

type RawActivityActorBot = {
  id?: string | null
  name?: string | null
  avatarUrl?: string | null
  type?: string | null
  subType?: string | null
  userDisplayName?: string | null
}

export type RawActivityNode = {
  id: string
  createdAt?: string | null
  updatedAt?: string | null
  actor?: RawUser | null
  botActor?: RawActivityActorBot | null
  fromTitle?: string | null
  toTitle?: string | null
  updatedDescription?: boolean | null
  fromPriority?: number | null
  toPriority?: number | null
  fromEstimate?: number | null
  toEstimate?: number | null
  fromDueDate?: string | null
  toDueDate?: string | null
  fromAssignee?: RawUser | null
  toAssignee?: RawUser | null
  fromDelegate?: RawUser | null
  toDelegate?: RawUser | null
  fromState?: RawActivityEntity | null
  toState?: RawActivityEntity | null
  fromProject?: RawActivityEntity | null
  toProject?: RawActivityEntity | null
  fromCycle?: RawActivityEntity | null
  toCycle?: RawActivityEntity | null
  fromParent?: RawActivityEntity | null
  toParent?: RawActivityEntity | null
  fromTeam?: RawActivityEntity | null
  toTeam?: RawActivityEntity | null
  fromProjectMilestone?: RawActivityEntity | null
  toProjectMilestone?: RawActivityEntity | null
  addedLabels?: RawActivityEntity[] | null
  removedLabels?: RawActivityEntity[] | null
  relationChanges?: { identifier?: string | null; type?: string | null }[] | null
  attachment?: RawActivityEntity | null
  archived?: boolean | null
  autoArchived?: boolean | null
  autoClosed?: boolean | null
  trashed?: boolean | null
}

export type RawActivityResponse = {
  issue?: {
    history?: { nodes?: RawActivityNode[]; pageInfo?: RawPageInfo } | null
  } | null
}

export const ACTIVITY_QUERY = `
  query OrcaAgentLinearIssueActivity($id: String!, $first: Int, $after: String) {
    issue(id: $id) {
      history(first: $first, after: $after) {
        nodes {
          id
          createdAt
          updatedAt
          actor { id displayName avatarUrl }
          botActor { id name avatarUrl type subType userDisplayName }
          fromTitle
          toTitle
          updatedDescription
          fromPriority
          toPriority
          fromEstimate
          toEstimate
          fromDueDate
          toDueDate
          fromAssignee { id displayName avatarUrl }
          toAssignee { id displayName avatarUrl }
          fromDelegate { id displayName avatarUrl }
          toDelegate { id displayName avatarUrl }
          fromState { id name type color }
          toState { id name type color }
          fromProject { id name color }
          toProject { id name color }
          fromCycle { id name }
          toCycle { id name }
          fromParent { id identifier title url }
          toParent { id identifier title url }
          fromTeam { id name key color }
          toTeam { id name key color }
          fromProjectMilestone { id name }
          toProjectMilestone { id name }
          addedLabels { id name color }
          removedLabels { id name color }
          relationChanges { identifier type }
          attachment { id title url }
          archived
          autoArchived
          autoClosed
          trashed
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`

export function mapActivity(node: RawActivityNode): LinearIssueActivityEntry {
  const changes: LinearIssueActivityEntry['changes'] = []
  pushActivityChange(changes, 'title', node.fromTitle, node.toTitle)
  if (node.updatedDescription) {
    changes.push({ field: 'description' })
  }
  pushActivityChange(changes, 'priority', node.fromPriority, node.toPriority)
  pushActivityChange(changes, 'estimate', node.fromEstimate, node.toEstimate)
  pushActivityChange(changes, 'dueDate', node.fromDueDate, node.toDueDate)
  pushActivityChange(changes, 'assignee', node.fromAssignee, node.toAssignee)
  pushActivityChange(changes, 'delegate', node.fromDelegate, node.toDelegate)
  pushActivityChange(changes, 'state', node.fromState, node.toState)
  pushActivityChange(changes, 'project', node.fromProject, node.toProject)
  pushActivityChange(changes, 'cycle', node.fromCycle, node.toCycle)
  pushActivityChange(changes, 'parent', node.fromParent, node.toParent)
  pushActivityChange(changes, 'team', node.fromTeam, node.toTeam)
  pushActivityChange(changes, 'milestone', node.fromProjectMilestone, node.toProjectMilestone)
  if (node.addedLabels?.length) {
    changes.push({ field: 'labelsAdded', to: node.addedLabels })
  }
  if (node.removedLabels?.length) {
    changes.push({ field: 'labelsRemoved', from: node.removedLabels })
  }
  if (node.relationChanges?.length) {
    changes.push({ field: 'relations', to: node.relationChanges })
  }
  if (node.attachment) {
    changes.push({ field: 'attachment', to: node.attachment })
  }
  for (const field of ['archived', 'autoArchived', 'autoClosed', 'trashed'] as const) {
    if (node[field] != null) {
      changes.push({ field, to: node[field] })
    }
  }
  const bot = node.botActor
  return {
    id: node.id,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    actor: node.actor
      ? { ...node.actor, kind: 'user' }
      : bot
        ? {
            id: bot.id,
            displayName: bot.userDisplayName ?? bot.name,
            avatarUrl: bot.avatarUrl,
            name: bot.name,
            type: bot.type,
            subType: bot.subType,
            kind: 'bot'
          }
        : { kind: 'system', displayName: 'Linear' },
    changes
  }
}

function pushActivityChange(
  changes: LinearIssueActivityEntry['changes'],
  field: string,
  from: LinearIssueActivityValue | undefined,
  to: LinearIssueActivityValue | undefined
): void {
  if (from == null && to == null) {
    return
  }
  changes.push({ field, from: from ?? null, to: to ?? null })
}
