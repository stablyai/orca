import type { ScryGroup } from '../model'
import { groupSchema } from '../schemas'
import type { ScryerOperationExecutor } from '../types'
import { diffModels, summarizePending } from '../diff'
import { failure, success } from './operation-result'
import {
  cloneModel,
  fieldErrorsFromZod,
  plannedOrFailure,
  stringField,
  type RecordInput
} from './structural-input'

export const groupSetOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  input,
  state
}) => {
  const stateFailure = plannedOrFailure(state, 'scryer.group.set')
  if (stateFailure) {
    return stateFailure
  }
  if (!Array.isArray(input.data)) {
    return failure('invalid_input', 'group.set data must be an array', undefined, {
      fieldErrors: [{ path: 'data', message: 'Expected group array' }]
    })
  }
  const parsed = input.data.map((group) => groupSchema.safeParse(group))
  const firstInvalid = parsed.find((result) => !result.success)
  if (firstInvalid && !firstInvalid.success) {
    return failure('invalid_input', 'group.set data failed schema validation', undefined, {
      fieldErrors: fieldErrorsFromZod(firstInvalid.error)
    })
  }
  const committed = state.committed ?? state.planned!
  const planned = cloneModel(state.planned!)
  planned.groups = parsed.map((result) => (result.success ? result.data : ({} as ScryGroup)))
  return success({
    result: {
      updatedCount: planned.groups.length,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}

export const groupUpdateOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  input,
  state
}) => {
  const stateFailure = plannedOrFailure(state, 'scryer.group.update')
  if (stateFailure) {
    return stateFailure
  }
  const committed = state.committed ?? state.planned!
  const planned = cloneModel(state.planned!)
  let updatedCount = 0
  for (const item of Array.isArray(input.items) ? input.items : []) {
    const record = item as RecordInput
    const groupId = stringField(record, 'group_id')
    const group = groupId ? planned.groups.find((candidate) => candidate.id === groupId) : undefined
    if (!group || !groupId) {
      return failure('not_found', `Group '${groupId ?? '<missing>'}' not found`, {
        entity: 'group',
        id: groupId ?? '<missing>',
        field: 'group_id'
      })
    }
    if (stringField(record, 'name') !== undefined) {
      group.name = stringField(record, 'name')!
    }
    if (stringField(record, 'description') !== undefined) {
      group.description = stringField(record, 'description')
    }
    if (Array.isArray(record.member_ids)) {
      group.memberIds = record.member_ids.map(String)
    }
    if (record.parent_group_id !== undefined || record.parent_node_id !== undefined) {
      const fieldPath =
        record.parent_group_id !== undefined ? 'items[].parent_group_id' : 'items[].parent_node_id'
      return failure(
        'invalid_input',
        'group.update cannot re-parent groups; use group.set for raw group repair',
        undefined,
        {
          fieldErrors: [
            {
              path: fieldPath,
              message: 'Re-parenting is not supported by group.update'
            }
          ]
        }
      )
    }
    updatedCount += 1
  }
  return success({
    result: {
      updatedCount,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}

export const groupDeleteOperation: ScryerOperationExecutor<RecordInput, RecordInput> = ({
  input,
  state
}) => {
  const stateFailure = plannedOrFailure(state, 'scryer.group.delete')
  if (stateFailure) {
    return stateFailure
  }
  const groupId = stringField(input, 'group_id')
  const deleted = groupId ? state.planned!.groups.find((group) => group.id === groupId) : undefined
  if (!groupId || !deleted) {
    return failure('not_found', `Group '${groupId ?? '<missing>'}' not found`, {
      entity: 'group',
      id: groupId ?? '<missing>',
      field: 'group_id'
    })
  }
  const committed = state.committed ?? state.planned!
  const planned = cloneModel(state.planned!)
  planned.groups = planned.groups
    .filter((group) => group.id !== groupId)
    .map((group) =>
      group.parentGroupId === groupId ? { ...group, parentGroupId: deleted.parentGroupId } : group
    )
  return success({
    result: {
      deletedCount: 1,
      pendingSummary: summarizePending(diffModels(committed, planned))
    },
    changes: { planned }
  })
}
