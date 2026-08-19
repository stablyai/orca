import type { LinearCollectionMeta } from '../../shared/linear/agent-result-types'
import type {
  LinearProjectShowResult,
  LinearProjectUpdateNode
} from '../../shared/linear/project-agent-access'
import type { LinearClientForWorkspace } from './client'
import { linearError } from './issue-context-errors'
import {
  boundedLinearEntityCollection,
  boundedLinearNullableString,
  boundedLinearString
} from './linear-text-digest'
import { runLinearProjectRead, type LinearProjectRawVariables } from './project-agent-request'
import { readProjectConnectionRows } from './project-connection-pages'
import {
  mapLinearProjectLabelRef,
  mapLinearProjectTeamRef,
  mapLinearProjectUserRef,
  toLinearProjectStatusType,
  toLinearProjectUpdateHealth
} from './project-reference-mapping'
import {
  PROJECT_SHOW_QUERY,
  PROJECT_SHOW_WITH_UPDATES_QUERY,
  type ProjectShowNode,
  type ProjectShowResponse,
  type ProjectShowUpdateNode
} from './project-show-query'
import type { LinearResolvedProject } from './project-target-resolution'
import { selectLinearProjectWorkspaces } from './project-workspace-scope'

export async function getProjectShowForAgent(
  project: LinearResolvedProject,
  options: { updates: boolean; updatesLimit: number; signal?: AbortSignal }
): Promise<LinearProjectShowResult> {
  const entry = selectLinearProjectWorkspaces(project.workspaceId, 'a project read')[0]
  const node = await readProjectShowNode(entry, project.id, options)
  if (!node) {
    throw linearError('linear_invalid_project', `Linear project ${project.id} was not found.`, {
      nextSteps: ['Run `orca linear project list --query <name> --json` and retry by id.']
    })
  }

  // Why: digests must cover every member/team/label id, so pages are followed before output caps apply.
  const [members, teams, labels] = await Promise.all([
    readProjectConnectionRows({
      entry,
      projectId: project.id,
      field: 'members',
      initial: node.members,
      map: mapLinearProjectUserRef,
      signal: options.signal
    }),
    readProjectConnectionRows({
      entry,
      projectId: project.id,
      field: 'teams',
      initial: node.teams,
      map: mapLinearProjectTeamRef,
      signal: options.signal
    }),
    readProjectConnectionRows({
      entry,
      projectId: project.id,
      field: 'labels',
      initial: node.labels,
      map: mapLinearProjectLabelRef,
      signal: options.signal
    })
  ])

  const updates = options.updates ? mapProjectUpdates(node.projectUpdates?.nodes ?? []) : undefined
  return {
    project: {
      id: node.id,
      name: node.name ?? '',
      slugId: node.slugId ?? '',
      url: node.url ?? '',
      description: boundedLinearString(node.description ?? ''),
      content: boundedLinearNullableString(node.content ?? null),
      status: {
        id: node.status?.id ?? '',
        name: node.status?.name ?? '',
        type: toLinearProjectStatusType(node.status?.type),
        color: node.status?.color ?? ''
      },
      lead: node.lead ? mapLinearProjectUserRef(node.lead) : null,
      members: boundedLinearEntityCollection(members),
      teams: boundedLinearEntityCollection(teams),
      labels: boundedLinearEntityCollection(labels),
      priority: node.priority ?? 0,
      startDate: node.startDate ?? null,
      targetDate: node.targetDate ?? null,
      color: node.color ?? '',
      icon: node.icon ?? null,
      health: toLinearProjectUpdateHealth(node.health),
      healthUpdatedAt: node.healthUpdatedAt ?? null
    },
    ...(updates ? { updates } : {}),
    meta: {
      workspaceId: project.workspaceId,
      workspaceName: project.workspaceName,
      resolvedBy: project.resolvedBy,
      ...(updates
        ? {
            updates: updatesMeta(
              updates.length,
              options.updatesLimit,
              node.projectUpdates?.pageInfo?.hasNextPage === true
            )
          }
        : {})
    }
  }
}

async function readProjectShowNode(
  entry: LinearClientForWorkspace,
  projectId: string,
  options: { updates: boolean; updatesLimit: number; signal?: AbortSignal }
): Promise<ProjectShowNode | null> {
  return await runLinearProjectRead(entry, options.signal, async (client) => {
    // Why: the default document never selects update bodies, so an ordinary read stays small.
    const result = await client.client.rawRequest<ProjectShowResponse, LinearProjectRawVariables>(
      options.updates ? PROJECT_SHOW_WITH_UPDATES_QUERY : PROJECT_SHOW_QUERY,
      options.updates ? { id: projectId, updatesLimit: options.updatesLimit } : { id: projectId }
    )
    return result.data?.project ?? null
  })
}

function mapProjectUpdates(nodes: ProjectShowUpdateNode[]): LinearProjectUpdateNode[] {
  return nodes
    .map((node) => ({
      id: node.id,
      body: boundedLinearString(node.body ?? ''),
      health: toLinearProjectUpdateHealth(node.health) ?? 'onTrack',
      url: node.url ?? '',
      isDiffHidden: node.isDiffHidden === true,
      isStale: node.isStale === true,
      createdAt: node.createdAt ?? '',
      updatedAt: node.updatedAt ?? '',
      editedAt: node.editedAt ?? null,
      user: node.user
        ? mapLinearProjectUserRef(node.user)
        : { id: '', displayName: '', avatarUrl: null }
    }))
    .sort((left, right) => compareUpdatesNewestFirst(left, right))
}

function compareUpdatesNewestFirst(
  left: LinearProjectUpdateNode,
  right: LinearProjectUpdateNode
): number {
  const leftAt = Date.parse(left.createdAt)
  const rightAt = Date.parse(right.createdAt)
  if (Number.isNaN(leftAt) || Number.isNaN(rightAt) || leftAt === rightAt) {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  }
  return rightAt - leftAt
}

function updatesMeta(returned: number, cap: number, hasMore: boolean): LinearCollectionMeta {
  return { returned, cap, capReached: returned >= cap, hasMore }
}
