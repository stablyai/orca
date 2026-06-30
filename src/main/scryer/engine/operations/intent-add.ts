import type { ScryGroup, ScryKind, ScryModel, ScryNode } from '../model'
import type { ScryerOperationExecutor } from '../types'
import { diffModels, summarizePending } from '../diff'
import { success } from './helpers'
import {
  cloneModel,
  plannedOrFailure,
  responsibilitiesFromInput,
  stringArrayField,
  stringField,
  type RecordInput
} from './structural-input'

function appendNode(args: {
  planned: ScryModel
  item: RecordInput
  kind: ScryKind
  ids: { node(): string; responsibility(): string }
}): ScryNode {
  const responsibilities = responsibilitiesFromInput(args.item.responsibilities, args.ids)
  const parentId = stringField(args.item, 'parent_id')
  const technology = stringField(args.item, 'technology')
  const description = stringField(args.item, 'description')
  const node: ScryNode = {
    id: args.ids.node(),
    kind: args.kind,
    name: stringField(args.item, 'name')?.trim() || 'Untitled',
    ...(parentId ? { parentId } : {}),
    ...(typeof args.item.external === 'boolean' ? { external: args.item.external } : {}),
    ...(technology ? { technology } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(responsibilities ? { responsibilities } : {}),
    ...(Array.isArray(args.item.properties) ? { properties: args.item.properties as never } : {}),
    ...(typeof args.item.visual === 'boolean' ? { visual: args.item.visual } : {}),
    ...(args.item.appearance && typeof args.item.appearance === 'object'
      ? { appearance: args.item.appearance as Record<string, unknown> }
      : {})
  }
  args.planned.nodes.push(node)
  const sourceFile = stringField(args.item, 'source_file')
  if (sourceFile) {
    args.planned.sourceMap[node.id] = [
      {
        pattern: sourceFile,
        ...(typeof args.item.line === 'number' ? { line: args.item.line } : {}),
        ...(typeof args.item.endLine === 'number' ? { endLine: args.item.endLine } : {})
      }
    ]
  }
  return node
}

function addNodesOperation(kind: ScryKind): ScryerOperationExecutor<RecordInput, RecordInput> {
  return ({ input, state, services }) => {
    const stateFailure = plannedOrFailure(state, `scryer.${kind}.add`)
    if (stateFailure) {
      return stateFailure
    }
    const committed = state.committed ?? state.planned!
    const planned = cloneModel(state.planned!)
    const added = (Array.isArray(input.items) ? input.items : []).map((item) =>
      appendNode({
        planned,
        item: item as RecordInput,
        kind,
        ids: services.ids
      })
    )
    return success({
      result: {
        added: added.map((node) => ({ kind: 'node', id: node.id, nodeKind: node.kind })),
        addedIds: added.map((node) => node.id),
        pendingSummary: summarizePending(diffModels(committed, planned))
      },
      changes: { planned }
    })
  }
}

export const personAddOperation = addNodesOperation('person')
export const systemAddOperation = addNodesOperation('system')
export const containerAddOperation = addNodesOperation('container')
export const componentAddOperation = addNodesOperation('component')
export const symbolAddOperation = addNodesOperation('symbol')

export const groupAddOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  input,
  state,
  services
}) => {
  const stateFailure = plannedOrFailure(state, 'scryer.group.add')
  if (stateFailure) {
    return stateFailure
  }
  const committed = state.committed ?? state.planned!
  const planned = cloneModel(state.planned!)
  const added = (Array.isArray(input.items) ? input.items : []).map((item) => {
    const record = item as RecordInput
    const responsibilities = responsibilitiesFromInput(record.responsibilities, services.ids)
    const parentId = stringField(record, 'parent_id')
    const description = stringField(record, 'description')
    const group: ScryGroup = {
      id: services.ids.group(),
      name: stringField(record, 'name')?.trim() || 'New group',
      memberIds: stringArrayField(record, 'member_ids') ?? [],
      ...(description !== undefined ? { description } : {}),
      ...(parentId ? { parentNodeId: parentId } : {}),
      ...(responsibilities ? { responsibilities } : {})
    }
    planned.groups.push(group)
    return group
  })
  return success({
    result: {
      added: added.map((group) => ({ kind: 'group', id: group.id })),
      addedIds: added.map((group) => group.id),
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
