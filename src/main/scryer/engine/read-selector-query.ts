import type { ScryModel, ScryNode } from './model'
import type {
  ScryerModelQueryHit,
  ScryerModelQueryInput,
  ScryerModelQueryResult,
  ScryerQueryCondition
} from './types'
import {
  childCounts,
  childMap,
  descendantIds,
  nodeMap,
  pathForNode
} from './read-selector-model-navigation'
import { invalidInput, nodeNotFound, type SelectorResult } from './read-selector-result'

const QUERY_CAP = 200

type FieldValue =
  | { kind: 'string'; value?: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }

function emptySymbol(node: ScryNode): boolean {
  return (
    node.kind === 'symbol' &&
    (node.responsibilities?.length ?? 0) === 0 &&
    (node.properties?.length ?? 0) === 0 &&
    !node.appearance
  )
}

function vagrantNode(node: ScryNode): boolean {
  return Boolean(
    node.vagrant ||
      node.responsibilities?.some((responsibility) => responsibility.vagrant) ||
      node.properties?.some((property) => property.vagrant)
  )
}

function resolveQueryField(
  node: ScryNode,
  field: string,
  childCount: number
): SelectorResult<FieldValue> {
  switch (field) {
    case 'kind':
      return { ok: true, result: { kind: 'string', value: node.kind } }
    case 'name':
      return { ok: true, result: { kind: 'string', value: node.name } }
    case 'description':
      return { ok: true, result: { kind: 'string', value: node.description } }
    case 'technology':
      return { ok: true, result: { kind: 'string', value: node.technology } }
    case 'external':
      return { ok: true, result: { kind: 'boolean', value: node.external === true } }
    case 'visual':
      return { ok: true, result: { kind: 'boolean', value: node.visual === true } }
    case 'empty':
      return { ok: true, result: { kind: 'boolean', value: emptySymbol(node) } }
    case 'vagrant':
      return { ok: true, result: { kind: 'boolean', value: vagrantNode(node) } }
    case 'responsibilityCount':
    case 'responsibilities':
      return { ok: true, result: { kind: 'number', value: node.responsibilities?.length ?? 0 } }
    case 'propertyCount':
    case 'properties':
      return { ok: true, result: { kind: 'number', value: node.properties?.length ?? 0 } }
    case 'childCount':
    case 'children':
      return { ok: true, result: { kind: 'number', value: childCount } }
    default:
      return invalidInput('where.field', `Unknown query field '${field}'`)
  }
}

function conditionMatches(value: FieldValue, condition: ScryerQueryCondition) {
  if (condition.op === 'exists' || condition.op === 'absent') {
    const present =
      value.kind === 'string'
        ? Boolean(value.value?.trim())
        : value.kind === 'number'
          ? value.value > 0
          : value.value
    return condition.op === 'exists' ? present : !present
  }
  if (condition.value === undefined) {
    return invalidInput('where.value', `Condition on '${condition.field}' requires value`)
  }
  if (value.kind === 'boolean') {
    if (typeof condition.value !== 'boolean') {
      return invalidInput('where.value', `Field '${condition.field}' requires a boolean value`)
    }
    if (condition.op === 'eq') {
      return value.value === condition.value
    }
    if (condition.op === 'ne') {
      return value.value !== condition.value
    }
    return invalidInput('where.op', `Operator '${condition.op}' is invalid for boolean fields`)
  }
  if (value.kind === 'number') {
    if (typeof condition.value !== 'number') {
      return invalidInput('where.value', `Field '${condition.field}' requires a number value`)
    }
    switch (condition.op) {
      case 'eq':
        return value.value === condition.value
      case 'ne':
        return value.value !== condition.value
      case 'gt':
        return value.value > condition.value
      case 'gte':
        return value.value >= condition.value
      case 'lt':
        return value.value < condition.value
      case 'lte':
        return value.value <= condition.value
      default:
        return invalidInput('where.op', `Operator '${condition.op}' is invalid for number fields`)
    }
  }
  if (typeof condition.value !== 'string') {
    return invalidInput('where.value', `Field '${condition.field}' requires a string value`)
  }
  const current = value.value ?? ''
  if (condition.op === 'eq') {
    return current.toLowerCase() === condition.value.toLowerCase()
  }
  if (condition.op === 'ne') {
    return current.toLowerCase() !== condition.value.toLowerCase()
  }
  if (condition.op === 'contains') {
    return current.toLowerCase().includes(condition.value.toLowerCase())
  }
  return invalidInput('where.op', `Operator '${condition.op}' is invalid for string fields`)
}

function scopeIds(model: ScryModel, under?: string): SelectorResult<Set<string> | null> {
  if (!under) {
    return { ok: true, result: null }
  }
  const children = childMap(model)
  if (!nodeMap(model).has(under)) {
    return nodeNotFound(under, 'under')
  }
  return { ok: true, result: descendantIds(under, children) }
}

function queryHit(
  node: ScryNode,
  model: ScryModel,
  nodes: Map<string, ScryNode>
): ScryerModelQueryHit {
  const childCount = childCounts(model).get(node.id) ?? 0
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    path: pathForNode(node, nodes),
    nResp: node.responsibilities?.length ?? 0,
    nProps: node.properties?.length ?? 0,
    childCount,
    ...(node.parentId ? { parentId: node.parentId } : {}),
    ...(node.external !== undefined ? { external: node.external } : {}),
    ...(node.visual !== undefined ? { visual: node.visual } : {}),
    ...(emptySymbol(node) ? { empty: true } : {}),
    ...(vagrantNode(node) ? { vagrant: true } : {})
  }
}

export function selectModelQuery(
  model: ScryModel,
  input: ScryerModelQueryInput
): SelectorResult<ScryerModelQueryResult> {
  const layer = input.layer ?? 'plan'
  const scoped = scopeIds(model, input.under)
  if (!scoped.ok) {
    return scoped
  }
  const nodes = nodeMap(model)
  const counts = childCounts(model)
  const hits: ScryerModelQueryHit[] = []
  let truncated = false
  for (const node of model.nodes) {
    if (scoped.result && !scoped.result.has(node.id)) {
      continue
    }
    let matched = true
    for (const condition of input.where) {
      const value = resolveQueryField(node, condition.field, counts.get(node.id) ?? 0)
      if (!value.ok) {
        return value
      }
      const result = conditionMatches(value.result, condition)
      if (typeof result === 'object') {
        return result
      }
      if (!result) {
        matched = false
        break
      }
    }
    if (!matched) {
      continue
    }
    if (hits.length >= QUERY_CAP) {
      truncated = true
      break
    }
    hits.push(queryHit(node, model, nodes))
  }
  return {
    ok: true,
    result: {
      layer,
      resultCount: hits.length,
      truncated,
      hits,
      where: input.where,
      ...(input.under ? { under: input.under } : {})
    }
  }
}
