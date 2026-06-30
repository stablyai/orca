import type {
  ArchitectureViewBoundaryRow,
  ArchitectureViewDiagnostic,
  ArchitectureViewDto,
  ArchitectureViewGroup,
  ArchitectureViewLink,
  ArchitectureViewNode,
  ArchitectureViewSourceMapRow,
  ArchitectureViewTreeRow
} from '../../shared/scryer/architecture-view'
import type {
  ScryerEngine,
  ScryerLayer,
  ScryerOperationContext,
  ScryerOperationResult,
  ScryerReadView
} from './engine'
import type { ScryGroup, ScryLink, ScryModel, ScryNode } from './engine/model'
import { validateModelStructure } from './engine/validators'

export type ArchitectureViewReadInput = {
  projectPath: string
  layer?: ScryerLayer
  focusNodeId?: string | null
}

export type ArchitectureViewAdapter = {
  readArchitectureView(
    input: ArchitectureViewReadInput,
    context: ScryerOperationContext
  ): Promise<ScryerOperationResult<ArchitectureViewDto>>
}

function nodeDto(node: ScryNode): ArchitectureViewNode {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.external !== undefined ? { external: node.external } : {}),
    ...(node.technology !== undefined ? { technology: node.technology } : {}),
    ...(node.description !== undefined ? { description: node.description } : {}),
    ...(node.vagrant !== undefined ? { vagrant: node.vagrant } : {}),
    ...(node.stale !== undefined ? { stale: node.stale } : {}),
    ...(node.responsibilities ? { responsibilities: node.responsibilities } : {}),
    ...(node.properties ? { properties: node.properties } : {}),
    ...(node.icon !== undefined ? { icon: node.icon } : {}),
    ...(node.visual !== undefined ? { visual: node.visual } : {}),
    ...(node.appearance !== undefined ? { appearance: node.appearance } : {}),
    ...(node.notes !== undefined ? { notes: node.notes } : {})
  }
}

function linkDto(link: ScryLink): ArchitectureViewLink {
  return {
    id: link.id,
    src: link.src,
    dst: link.dst,
    label: link.label,
    ...(link.method !== undefined ? { method: link.method } : {})
  }
}

function groupDto(group: ScryGroup): ArchitectureViewGroup {
  return {
    id: group.id,
    name: group.name,
    memberIds: group.memberIds,
    ...(group.description !== undefined ? { description: group.description } : {}),
    ...(group.parentGroupId !== undefined ? { parentGroupId: group.parentGroupId } : {}),
    ...(group.parentNodeId !== undefined ? { parentNodeId: group.parentNodeId } : {}),
    ...(group.responsibilities ? { responsibilities: group.responsibilities } : {}),
    ...(group.icon !== undefined ? { icon: group.icon } : {})
  }
}

function modelFromReadView(view: ScryerReadView): ScryModel | null {
  const legacyView = view as ScryerReadView & { fullModel?: ScryModel; mode?: string }
  const model = (view as ScryerReadView & { model?: ScryModel }).model
  return (
    legacyView.fullModel ??
    (view.view === 'full' || legacyView.mode === 'full' ? (model ?? null) : null)
  )
}

function pathForNode(node: ScryNode, nodesById: Map<string, ScryNode>): string {
  const names: string[] = [node.name]
  let current = node.parentId ? nodesById.get(node.parentId) : undefined
  while (current) {
    names.unshift(current.name)
    current = current.parentId ? nodesById.get(current.parentId) : undefined
  }
  return names.join(' / ')
}

function treeRowsFromModel(model: ScryModel): ArchitectureViewTreeRow[] {
  const nodesById = new Map(model.nodes.map((node) => [node.id, node]))
  const childCounts = new Map<string, number>()
  for (const node of model.nodes) {
    if (node.parentId) {
      childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1)
    }
  }
  return model.nodes.map((node) => {
    const path = pathForNode(node, nodesById)
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      depth: Math.max(path.split(' / ').length - 1, 0),
      path,
      childCount: childCounts.get(node.id) ?? 0,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(node.stale !== undefined ? { stale: node.stale } : {}),
      ...(node.vagrant !== undefined ? { vagrant: node.vagrant } : {})
    }
  })
}

function sourceMapRowsFromModel(model: ScryModel): ArchitectureViewSourceMapRow[] {
  return Object.entries(model.sourceMap)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([ownerId, locations]) => ({ ownerId, locations }))
}

function boundaryRowsFromModel(model: ScryModel): ArchitectureViewBoundaryRow[] {
  return Object.entries(model.boundaries)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, sources]) => ({ nodeId, sources }))
}

function diagnosticsFromModel(model: ScryModel): ArchitectureViewDiagnostic[] {
  return validateModelStructure(model).map((finding) => ({
    severity: finding.severity,
    code: finding.code,
    message: finding.message,
    ...(finding.path ? { path: finding.path } : {})
  }))
}

function dtoFromModel(
  model: ScryModel,
  view: ScryerReadView,
  refresh: ArchitectureViewDto['refresh']
): ArchitectureViewDto {
  const nodes = model.nodes.map(nodeDto)
  const links = model.links.map(linkDto)
  const groups = model.groups.map(groupDto)
  const focusNodeId = refresh.focusNodeId
  const selectedNode = focusNodeId ? nodes.find((node) => node.id === focusNodeId) : undefined
  return {
    version: model.version,
    layer: view.layer,
    nodes,
    links,
    groups,
    sourceMap: model.sourceMap,
    boundaries: model.boundaries,
    treeRows: treeRowsFromModel(model),
    sourceMapRows: sourceMapRowsFromModel(model),
    boundaryRows: boundaryRowsFromModel(model),
    driftIndicators: nodes
      .filter((node) => node.stale || node.vagrant)
      .map((node) => ({
        nodeId: node.id,
        ...(node.stale !== undefined ? { stale: node.stale } : {}),
        ...(node.vagrant !== undefined ? { vagrant: node.vagrant } : {})
      })),
    diagnostics: diagnosticsFromModel(model),
    recommendedNextReads:
      (
        view as ScryerReadView & {
          recommendedNextReads?: ArchitectureViewDto['recommendedNextReads']
        }
      ).recommendedNextReads ?? [],
    ...(selectedNode
      ? {
          selectedDetails: {
            node: selectedNode,
            sourceLocations: model.sourceMap[selectedNode.id] ?? [],
            boundarySources: model.boundaries[selectedNode.id] ?? [],
            incomingLinks: links.filter((link) => link.dst === selectedNode.id),
            outgoingLinks: links.filter((link) => link.src === selectedNode.id),
            groups: groups.filter((group) => group.memberIds.includes(selectedNode.id))
          }
        }
      : {}),
    summary: {
      nodeCount: model.nodes.length,
      linkCount: model.links.length,
      groupCount: model.groups.length
    },
    refresh
  }
}

export function createArchitectureViewAdapter(engine: ScryerEngine): ArchitectureViewAdapter {
  return {
    async readArchitectureView(input, context) {
      const focusNodeId = input.focusNodeId?.trim() || undefined
      const result = await engine.readView(
        {
          layer: input.layer ?? 'plan',
          view: 'full'
        },
        {
          ...context,
          cwd: input.projectPath,
          projectRoot: input.projectPath
        }
      )
      if (!result.ok) {
        return {
          ok: false,
          operationId: 'architecture.readArchitectureView',
          requestId: result.requestId,
          error: result.error,
          ...(result.meta ? { meta: result.meta } : {})
        }
      }
      const model = modelFromReadView(result.result)
      if (!model) {
        return {
          ok: false,
          operationId: 'architecture.readArchitectureView',
          requestId: result.requestId,
          error: {
            code: 'internal_error',
            message: 'Scryer readView did not return a full model for Architecture view',
            details: { reason: 'unexpected_exception' },
            retryable: false
          }
        }
      }
      return {
        ok: true,
        operationId: 'architecture.readArchitectureView',
        requestId: result.requestId,
        result: dtoFromModel(model, result.result, {
          strategy: focusNodeId ? 'focus' : 'overview',
          ...(focusNodeId ? { focusNodeId } : {})
        }),
        ...(result.meta ? { meta: result.meta } : {})
      }
    }
  }
}
