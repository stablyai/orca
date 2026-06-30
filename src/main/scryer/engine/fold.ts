import type {
  ScryGroup,
  ScryModel,
  ScryNode,
  ScryResponsibility,
  ScrySchemaProperty
} from './model'
import { ScryerEngineError } from './engine-error'
import type { ScryerFoldService, ScryerFoldTarget, ScryerFoldedItem } from './types'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

function findResponsibility(
  model: ScryModel,
  id: string
): { ownerId: string; responsibility: ScryResponsibility } | null {
  for (const node of model.nodes) {
    const responsibility = node.responsibilities?.find((item) => item.id === id)
    if (responsibility) {
      return { ownerId: node.id, responsibility }
    }
  }
  for (const group of model.groups) {
    const responsibility = group.responsibilities?.find((item) => item.id === id)
    if (responsibility) {
      return { ownerId: group.id, responsibility }
    }
  }
  return null
}

function responsibilityHosts(model: ScryModel): (ScryNode | ScryGroup)[] {
  return [...model.nodes, ...model.groups]
}

function foldResponsibility(
  committed: ScryModel,
  planned: ScryModel,
  id: string
): ScryerFoldedItem {
  for (const host of responsibilityHosts(committed)) {
    host.responsibilities = (host.responsibilities ?? []).filter((item) => item.id !== id)
  }
  const plannedResponsibility = findResponsibility(planned, id)
  if (!plannedResponsibility) {
    delete committed.sourceMap[id]
    return { kind: 'responsibility', id, change: 'deleted' }
  }
  const host = responsibilityHosts(committed).find(
    (item) => item.id === plannedResponsibility.ownerId
  )
  if (!host) {
    throw new ScryerEngineError(
      'not_found',
      `cannot fold responsibility '${id}': host '${plannedResponsibility.ownerId}' is not committed`,
      { entity: 'responsibility', id, field: 'ownerId' }
    )
  }
  host.responsibilities = [
    ...(host.responsibilities ?? []),
    {
      ...plannedResponsibility.responsibility,
      vagrant: undefined,
      stale: undefined,
      staleProposal: undefined
    }
  ]
  if (planned.sourceMap[id]) {
    committed.sourceMap[id] = planned.sourceMap[id]
    delete planned.sourceMap[id]
  }
  return {
    kind: 'responsibility',
    id,
    ownerId: plannedResponsibility.ownerId,
    change: 'folded'
  }
}

function foldLink(committed: ScryModel, planned: ScryModel, id: string): ScryerFoldedItem {
  committed.links = committed.links.filter((link) => link.id !== id)
  const plannedLink = planned.links.find((link) => link.id === id)
  if (plannedLink) {
    committed.links.push(plannedLink)
  }
  return { kind: 'link', id, change: plannedLink ? 'folded' : 'deleted' }
}

function descendantIds(model: ScryModel, id: string): Set<string> {
  const out = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const node of model.nodes) {
      if (
        !out.has(node.id) &&
        (node.parentId === id || (node.parentId && out.has(node.parentId)))
      ) {
        out.add(node.id)
        changed = true
      }
    }
  }
  return out
}

function clearNodeDependentState(model: ScryModel, nodeIds: Set<string>): void {
  const responsibilityIds = new Set<string>()
  for (const node of model.nodes) {
    if (nodeIds.has(node.id)) {
      for (const responsibility of node.responsibilities ?? []) {
        responsibilityIds.add(responsibility.id)
      }
    }
  }
  model.links = model.links.filter((link) => !nodeIds.has(link.src) && !nodeIds.has(link.dst))
  for (const id of [...nodeIds, ...responsibilityIds]) {
    delete model.sourceMap[id]
    delete model.boundaries[id]
  }
  for (const group of model.groups) {
    group.memberIds = group.memberIds.filter((id) => !nodeIds.has(id))
  }
}

function foldNode(
  committed: ScryModel,
  planned: ScryModel,
  id: string,
  includeDescendants = false
): ScryerFoldedItem[] {
  const folded: ScryerFoldedItem[] = []
  const nodeIds = new Set([id])
  if (includeDescendants || !planned.nodes.some((node) => node.id === id)) {
    for (const descendantId of descendantIds(committed, id)) {
      nodeIds.add(descendantId)
    }
  }
  for (const nodeId of nodeIds) {
    committed.nodes = committed.nodes.filter((node) => node.id !== nodeId)
    const plannedNode = planned.nodes.find((node) => node.id === nodeId)
    if (plannedNode) {
      committed.nodes.push({
        ...plannedNode,
        vagrant: undefined,
        stale: undefined
      })
      if (planned.sourceMap[nodeId]) {
        committed.sourceMap[nodeId] = planned.sourceMap[nodeId]
        delete planned.sourceMap[nodeId]
      }
      if (planned.boundaries[nodeId]) {
        committed.boundaries[nodeId] = planned.boundaries[nodeId]
        delete planned.boundaries[nodeId]
      }
      folded.push({ kind: 'node', id: nodeId, change: 'folded' })
    } else {
      folded.push({ kind: 'node', id: nodeId, change: 'deleted' })
    }
  }
  clearNodeDependentState(
    committed,
    new Set([...nodeIds].filter((nodeId) => !planned.nodes.some((node) => node.id === nodeId)))
  )
  return folded
}

function foldProperty(
  committed: ScryModel,
  planned: ScryModel,
  ownerId: string,
  label: string
): ScryerFoldedItem {
  const committedNode = committed.nodes.find((node) => node.id === ownerId)
  if (!committedNode) {
    throw new ScryerEngineError('not_found', `Node '${ownerId}' not found`, {
      entity: 'node',
      id: ownerId
    })
  }
  committedNode.properties = (committedNode.properties ?? []).filter((item) => item.label !== label)
  const plannedProperty = planned.nodes
    .find((node) => node.id === ownerId)
    ?.properties?.find((item) => item.label === label) as ScrySchemaProperty | undefined
  if (plannedProperty) {
    committedNode.properties = [
      ...(committedNode.properties ?? []),
      { ...plannedProperty, vagrant: undefined, stale: undefined }
    ]
  }
  return { kind: 'property', id: label, ownerId, change: plannedProperty ? 'folded' : 'deleted' }
}

function foldGroup(committed: ScryModel, planned: ScryModel, id: string): ScryerFoldedItem {
  committed.groups = committed.groups.filter((group) => group.id !== id)
  const plannedGroup = planned.groups.find((group) => group.id === id)
  if (plannedGroup) {
    committed.groups.push(plannedGroup)
  } else {
    for (const group of committed.groups) {
      if (group.parentGroupId === id) {
        group.parentGroupId = undefined
      }
    }
  }
  return { kind: 'group', id, change: plannedGroup ? 'folded' : 'deleted' }
}

export function foldTargets(args: {
  committed: ScryModel
  planned: ScryModel
  targets: ScryerFoldTarget[]
}): { committed: ScryModel; planned: ScryModel; folded: ScryerFoldedItem[] } {
  const committed = cloneModel(args.committed)
  const planned = cloneModel(args.planned)
  const folded: ScryerFoldedItem[] = []
  for (const target of args.targets) {
    switch (target.kind) {
      case 'node':
        folded.push(
          ...foldNode(committed, planned, target.node_id, target.includeDescendants ?? false)
        )
        break
      case 'responsibility':
        folded.push(foldResponsibility(committed, planned, target.responsibility_id))
        break
      case 'property':
        folded.push(foldProperty(committed, planned, target.node_id, target.label))
        break
      case 'link':
        folded.push(foldLink(committed, planned, target.link_id))
        break
      case 'group':
        folded.push(foldGroup(committed, planned, target.group_id))
        break
    }
  }
  return { committed, planned, folded }
}

export function createScryerFoldService(): ScryerFoldService {
  return { foldTargets }
}
