import type { ScryModel } from './model'
import type { ScryerSourceRouteDecision, ScryerSourceRouter, ScryerSourceTarget } from './types'

function cloneModel(model: ScryModel): ScryModel {
  return JSON.parse(JSON.stringify(model)) as ScryModel
}

function hasNode(model: ScryModel, nodeId: string): boolean {
  return model.nodes.some((node) => node.id === nodeId)
}

function hasResponsibility(model: ScryModel, responsibilityId: string): boolean {
  return [...model.nodes, ...model.groups].some((host) =>
    (host.responsibilities ?? []).some((responsibility) => responsibility.id === responsibilityId)
  )
}

function keyForTarget(target: ScryerSourceTarget): string {
  switch (target.kind) {
    case 'node':
      return target.nodeId
    case 'responsibility':
      return target.responsibilityId
    case 'raw':
      return target.key
  }
}

function targetInModel(model: ScryModel, target: ScryerSourceTarget): boolean {
  switch (target.kind) {
    case 'node':
      return hasNode(model, target.nodeId)
    case 'responsibility':
      return hasResponsibility(model, target.responsibilityId)
    case 'raw':
      return Boolean(model.sourceMap[target.key])
  }
}

function routeForTarget(args: {
  targetKind: 'sourceMap' | 'boundary'
  key: string
  target: ScryerSourceTarget
  entry?: ScryModel['sourceMap'][string] | ScryModel['boundaries'][string]
  committed: ScryModel
  planned: ScryModel
}): ScryerSourceRouteDecision {
  if (!args.entry) {
    return {
      targetKind: args.targetKind,
      key: args.key,
      targetLayer: targetInModel(args.committed, args.target) ? 'committed' : 'planned',
      clearOtherLayer: true,
      reason: 'clear_requested'
    }
  }
  if (targetInModel(args.committed, args.target)) {
    return {
      targetKind: args.targetKind,
      key: args.key,
      targetLayer: 'committed',
      clearOtherLayer: true,
      reason: 'target_in_committed',
      entry: args.entry
    }
  }
  return {
    targetKind: args.targetKind,
    key: args.key,
    targetLayer: 'planned',
    clearOtherLayer: true,
    reason: 'target_only_in_planned',
    entry: args.entry
  }
}

export function createScryerSourceRouter(): ScryerSourceRouter {
  return {
    routeSourceEntry(args) {
      return routeForTarget({
        targetKind: 'sourceMap',
        key: keyForTarget(args.target),
        target: args.target,
        entry: args.entry,
        committed: args.committed,
        planned: args.planned
      })
    },
    routeBoundaryEntry(args) {
      return routeForTarget({
        targetKind: 'boundary',
        key: args.nodeId,
        target: { kind: 'node', nodeId: args.nodeId },
        entry: args.entry,
        committed: args.committed,
        planned: args.planned
      })
    },
    clearSourceTarget(args) {
      return routeForTarget({
        targetKind: 'sourceMap',
        key: keyForTarget(args.target),
        target: args.target,
        committed: args.committed,
        planned: args.planned
      })
    },
    applySourceRoutes(args) {
      const committed = cloneModel(args.committed)
      const planned = cloneModel(args.planned)
      for (const decision of args.decisions) {
        const target = decision.targetKind === 'sourceMap' ? 'sourceMap' : 'boundaries'
        const targetModel = decision.targetLayer === 'committed' ? committed : planned
        const otherModel = decision.targetLayer === 'committed' ? planned : committed
        if (decision.entry) {
          targetModel[target][decision.key] = decision.entry as never
        } else {
          delete targetModel[target][decision.key]
        }
        if (decision.clearOtherLayer) {
          delete otherModel[target][decision.key]
        }
      }
      return { committed, planned, routed: args.decisions }
    }
  }
}
