import {
  LINEAR_PROJECT_STATUS_TYPES,
  LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES,
  type LinearProjectLabelRef,
  type LinearProjectStatusType,
  type LinearProjectTeamRef,
  type LinearProjectUpdateHealth,
  type LinearProjectUserRef
} from '../../shared/linear/project-agent-access'
import type {
  ProjectShowLabelNode,
  ProjectShowTeamNode,
  ProjectShowUserNode
} from './project-show-query'

/** Unknown future status types degrade to backlog rather than failing the read. */
export function toLinearProjectStatusType(
  value: string | null | undefined
): LinearProjectStatusType {
  const match = LINEAR_PROJECT_STATUS_TYPES.find((type) => type === value)
  return match ?? 'backlog'
}

export function toLinearProjectUpdateHealth(
  value: string | null | undefined
): LinearProjectUpdateHealth | null {
  return LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES.find((health) => health === value) ?? null
}

export function mapLinearProjectUserRef(node: ProjectShowUserNode): LinearProjectUserRef {
  return {
    id: node.id,
    displayName: node.displayName ?? '',
    avatarUrl: node.avatarUrl ?? null
  }
}

export function mapLinearProjectTeamRef(node: ProjectShowTeamNode): LinearProjectTeamRef {
  return { id: node.id, name: node.name ?? '', key: node.key ?? '' }
}

export function mapLinearProjectLabelRef(node: ProjectShowLabelNode): LinearProjectLabelRef {
  return {
    id: node.id,
    name: node.name ?? '',
    color: node.color ?? '',
    parent: node.parent ? { id: node.parent.id, name: node.parent.name ?? '' } : null
  }
}
