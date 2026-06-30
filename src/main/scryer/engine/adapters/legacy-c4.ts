import type { C4Edge, C4ModelData, C4Node } from '../../../../shared/scryer/model-types'
import { SCRY_VERSION, type ScryGroup, type ScryModel, type ScryNode } from '../model'

function mapNode(node: C4Node): ScryNode {
  return {
    id: node.id,
    kind:
      node.data.kind === 'operation' || node.data.kind === 'process' || node.data.kind === 'model'
        ? 'symbol'
        : node.data.kind,
    name: node.data.name,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.data.external !== undefined ? { external: node.data.external } : {}),
    ...(node.data.technology ? { technology: node.data.technology } : {}),
    ...(node.data.description ? { description: node.data.description } : {}),
    ...(node.data.properties
      ? {
          properties: node.data.properties.map((property) => ({
            label: property.label,
            description: property.description
          }))
        }
      : {})
  }
}

function mapEdge(edge: C4Edge): ScryModel['links'][number] {
  return {
    id: edge.id,
    src: edge.source,
    dst: edge.target,
    label: edge.data?.label ?? '',
    ...(edge.data?.method ? { method: edge.data.method } : {})
  }
}

function mapGroup(group: NonNullable<C4ModelData['groups']>[number]): ScryGroup {
  return {
    id: group.id,
    name: group.name,
    memberIds: [...group.memberIds],
    ...(group.description ? { description: group.description } : {}),
    ...(group.parentGroupId ? { parentGroupId: group.parentGroupId } : {})
  }
}

export function legacyC4ToScryModel(model: C4ModelData): ScryModel {
  return {
    version: SCRY_VERSION,
    nodes: model.nodes.map(mapNode),
    links: model.edges.map(mapEdge),
    groups: (model.groups ?? []).map(mapGroup),
    sourceMap: Object.fromEntries(
      Object.entries(model.sourceMap ?? {}).map(([key, locations]) => [
        key,
        locations.map((location) => ({
          pattern: location.pattern,
          ...(location.line !== undefined ? { line: location.line } : {}),
          ...(location.endLine !== undefined ? { endLine: location.endLine } : {}),
          ...(location.command ? { command: location.command } : {})
        }))
      ])
    ),
    boundaries: {}
  }
}
