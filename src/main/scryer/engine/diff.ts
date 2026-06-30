import type { ScryGroup, ScryModel, ScrySchemaProperty } from './model'
import type { PendingSummary } from './types'

export type PendingChangeType =
  | 'added'
  | 'deleted'
  | 'moved'
  | 'repointed'
  | 'reworded'
  | 'membersChanged'

export type PendingChange = {
  kind: 'node' | 'link' | 'responsibility' | 'property' | 'group'
  id: string
  ownerId?: string
  label: string
  changes: (
    | { type: 'added' | 'deleted' | 'membersChanged' }
    | { type: 'moved'; from?: string; to?: string }
    | { type: 'repointed'; srcFrom: string; srcTo: string; dstFrom: string; dstTo: string }
    | { type: 'reworded'; field: string; from: string; to: string }
  )[]
}

function reword(
  changes: PendingChange['changes'],
  field: string,
  from: string | undefined,
  to: string | undefined
): void {
  const left = from ?? ''
  const right = to ?? ''
  if (left !== right) {
    changes.push({ type: 'reworded', field, from: left, to: right })
  }
}

function indexResponsibilities(
  model: ScryModel
): Map<string, { ownerId: string; statement: string; directives: string[] }> {
  const out = new Map<string, { ownerId: string; statement: string; directives: string[] }>()
  for (const node of model.nodes) {
    for (const responsibility of node.responsibilities ?? []) {
      out.set(responsibility.id, {
        ownerId: node.id,
        statement: responsibility.statement,
        directives: responsibility.directives ?? []
      })
    }
  }
  for (const group of model.groups) {
    for (const responsibility of group.responsibilities ?? []) {
      out.set(responsibility.id, {
        ownerId: group.id,
        statement: responsibility.statement,
        directives: responsibility.directives ?? []
      })
    }
  }
  return out
}

function indexProperties(
  model: ScryModel
): Map<string, { ownerId: string; property: ScrySchemaProperty }> {
  const out = new Map<string, { ownerId: string; property: ScrySchemaProperty }>()
  for (const node of model.nodes) {
    for (const property of node.properties ?? []) {
      out.set(`${node.id}:${property.label}`, { ownerId: node.id, property })
    }
  }
  return out
}

function groupLabel(group: ScryGroup): string {
  return group.name || group.id
}

export function diffModels(from: ScryModel, to: ScryModel): PendingChange[] {
  const changes: PendingChange[] = []
  const fromNodes = new Map(from.nodes.map((node) => [node.id, node]))
  const toNodes = new Map(to.nodes.map((node) => [node.id, node]))
  for (const [id, node] of toNodes) {
    const previous = fromNodes.get(id)
    if (!previous) {
      changes.push({ kind: 'node', id, label: node.name, changes: [{ type: 'added' }] })
      continue
    }
    const nodeChanges: PendingChange['changes'] = []
    if (previous.parentId !== node.parentId) {
      nodeChanges.push({ type: 'moved', from: previous.parentId, to: node.parentId })
    }
    reword(nodeChanges, 'name', previous.name, node.name)
    reword(nodeChanges, 'technology', previous.technology, node.technology)
    reword(nodeChanges, 'description', previous.description, node.description)
    if (nodeChanges.length > 0) {
      changes.push({ kind: 'node', id, label: node.name, changes: nodeChanges })
    }
  }
  for (const [id, node] of fromNodes) {
    if (!toNodes.has(id)) {
      changes.push({ kind: 'node', id, label: node.name, changes: [{ type: 'deleted' }] })
    }
  }

  const fromResponsibilities = indexResponsibilities(from)
  const toResponsibilities = indexResponsibilities(to)
  for (const [id, responsibility] of toResponsibilities) {
    const previous = fromResponsibilities.get(id)
    if (!previous) {
      changes.push({
        kind: 'responsibility',
        id,
        ownerId: responsibility.ownerId,
        label: responsibility.statement,
        changes: [{ type: 'added' }]
      })
      continue
    }
    const responsibilityChanges: PendingChange['changes'] = []
    if (previous.ownerId !== responsibility.ownerId) {
      responsibilityChanges.push({
        type: 'moved',
        from: previous.ownerId,
        to: responsibility.ownerId
      })
    }
    reword(responsibilityChanges, 'statement', previous.statement, responsibility.statement)
    reword(
      responsibilityChanges,
      'directives',
      previous.directives.join('\n'),
      responsibility.directives.join('\n')
    )
    if (responsibilityChanges.length > 0) {
      changes.push({
        kind: 'responsibility',
        id,
        ownerId: responsibility.ownerId,
        label: responsibility.statement,
        changes: responsibilityChanges
      })
    }
  }
  for (const [id, responsibility] of fromResponsibilities) {
    if (!toResponsibilities.has(id)) {
      changes.push({
        kind: 'responsibility',
        id,
        ownerId: responsibility.ownerId,
        label: responsibility.statement,
        changes: [{ type: 'deleted' }]
      })
    }
  }

  const fromProperties = indexProperties(from)
  const toProperties = indexProperties(to)
  for (const [key, property] of toProperties) {
    const previous = fromProperties.get(key)
    if (!previous) {
      changes.push({
        kind: 'property',
        id: property.property.label,
        ownerId: property.ownerId,
        label: property.property.label,
        changes: [{ type: 'added' }]
      })
      continue
    }
    const propertyChanges: PendingChange['changes'] = []
    reword(
      propertyChanges,
      'description',
      previous.property.description,
      property.property.description
    )
    if ((previous.property.vagrant ?? false) !== (property.property.vagrant ?? false)) {
      reword(
        propertyChanges,
        'vagrant',
        String(previous.property.vagrant),
        String(property.property.vagrant)
      )
    }
    if ((previous.property.stale ?? false) !== (property.property.stale ?? false)) {
      reword(
        propertyChanges,
        'stale',
        String(previous.property.stale),
        String(property.property.stale)
      )
    }
    if (propertyChanges.length > 0) {
      changes.push({
        kind: 'property',
        id: property.property.label,
        ownerId: property.ownerId,
        label: property.property.label,
        changes: propertyChanges
      })
    }
  }
  for (const [key, property] of fromProperties) {
    if (!toProperties.has(key)) {
      changes.push({
        kind: 'property',
        id: property.property.label,
        ownerId: property.ownerId,
        label: property.property.label,
        changes: [{ type: 'deleted' }]
      })
    }
  }

  const fromLinks = new Map(from.links.map((link) => [link.id, link]))
  const toLinks = new Map(to.links.map((link) => [link.id, link]))
  for (const [id, link] of toLinks) {
    const previous = fromLinks.get(id)
    if (!previous) {
      changes.push({ kind: 'link', id, label: link.label, changes: [{ type: 'added' }] })
      continue
    }
    const linkChanges: PendingChange['changes'] = []
    if (previous.src !== link.src || previous.dst !== link.dst) {
      linkChanges.push({
        type: 'repointed',
        srcFrom: previous.src,
        srcTo: link.src,
        dstFrom: previous.dst,
        dstTo: link.dst
      })
    }
    reword(linkChanges, 'label', previous.label, link.label)
    reword(linkChanges, 'method', previous.method, link.method)
    if (linkChanges.length > 0) {
      changes.push({ kind: 'link', id, label: link.label, changes: linkChanges })
    }
  }
  for (const [id, link] of fromLinks) {
    if (!toLinks.has(id)) {
      changes.push({ kind: 'link', id, label: link.label, changes: [{ type: 'deleted' }] })
    }
  }

  const fromGroups = new Map(from.groups.map((group) => [group.id, group]))
  const toGroups = new Map(to.groups.map((group) => [group.id, group]))
  for (const [id, group] of toGroups) {
    const previous = fromGroups.get(id)
    if (!previous) {
      changes.push({ kind: 'group', id, label: groupLabel(group), changes: [{ type: 'added' }] })
      continue
    }
    const groupChanges: PendingChange['changes'] = []
    reword(groupChanges, 'name', previous.name, group.name)
    reword(groupChanges, 'description', previous.description, group.description)
    const beforeMembers = [...previous.memberIds].sort().join('\n')
    const afterMembers = [...group.memberIds].sort().join('\n')
    if (beforeMembers !== afterMembers || previous.parentGroupId !== group.parentGroupId) {
      groupChanges.push({ type: 'membersChanged' })
    }
    if (groupChanges.length > 0) {
      changes.push({ kind: 'group', id, label: groupLabel(group), changes: groupChanges })
    }
  }
  for (const [id, group] of fromGroups) {
    if (!toGroups.has(id)) {
      changes.push({ kind: 'group', id, label: groupLabel(group), changes: [{ type: 'deleted' }] })
    }
  }

  return changes
}

export function summarizePending(changes: PendingChange[]): PendingSummary {
  const summary: PendingSummary = {
    total: 0,
    byKind: {},
    byChange: {},
    toImplement: 0,
    toReimplement: 0,
    toMove: 0,
    toDelete: 0,
    toRepoint: 0
  }
  for (const change of changes) {
    summary.byKind[change.kind] = (summary.byKind[change.kind] ?? 0) + 1
    for (const item of change.changes) {
      summary.total += 1
      summary.byChange[item.type] = (summary.byChange[item.type] ?? 0) + 1
      switch (item.type) {
        case 'added':
          summary.toImplement += 1
          break
        case 'reworded':
          summary.toReimplement += 1
          break
        case 'moved':
        case 'membersChanged':
          summary.toMove += 1
          break
        case 'deleted':
          summary.toDelete += 1
          break
        case 'repointed':
          summary.toRepoint += 1
          break
      }
    }
  }
  return summary
}
