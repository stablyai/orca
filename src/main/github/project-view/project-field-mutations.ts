import { projectGhExecOptions, runGraphql, type GraphqlVars } from './internals'
import type { GitHubProjectFieldMutationValue } from '../../../shared/github/project-types'
import type { GitHubProjectMutationResult } from '../../../shared/github/project-result-types'
import type {
  ClearProjectItemFieldArgs,
  UpdateProjectItemFieldArgs
} from '../../../shared/github/project-request-types'

class UnknownFieldMutationKindError extends Error {
  constructor(kind: string) {
    super(`Unknown project field mutation kind: ${kind}`)
  }
}

function graphqlValueForFieldMutation(value: GitHubProjectFieldMutationValue): string {
  switch (value.kind) {
    case 'single-select':
      return 'singleSelectOptionId: $value'
    case 'iteration':
      return 'iterationId: $value'
    case 'text':
      return 'text: $value'
    case 'number':
      return 'number: $value'
    case 'date':
      return 'date: $value'
  }
  throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
}

function mutationValueVar(value: GitHubProjectFieldMutationValue): {
  type: string
  val: string | number
} {
  switch (value.kind) {
    case 'single-select':
      return { type: 'String!', val: value.optionId }
    case 'iteration':
      return { type: 'String!', val: value.iterationId }
    case 'text':
      return { type: 'String!', val: value.text }
    case 'number':
      return { type: 'Float!', val: value.number }
    case 'date':
      return { type: 'Date!', val: value.date }
  }
  throw new UnknownFieldMutationKindError((value as { kind: string }).kind)
}

export async function updateProjectItemFieldValue(
  args: UpdateProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  let valueFragment: string
  let valueVariable: { type: string; val: string | number }
  try {
    valueFragment = graphqlValueForFieldMutation(args.value)
    valueVariable = mutationValueVar(args.value)
  } catch (error) {
    if (error instanceof UnknownFieldMutationKindError) {
      return { ok: false, error: { type: 'validation_error', message: error.message } }
    }
    throw error
  }
  const query = `
    mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!, $value:${valueVariable.type}) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId
        itemId: $itemId
        fieldId: $fieldId
        value: { ${valueFragment} }
      }) { projectV2Item { id } }
    }
  `
  const vars: GraphqlVars = {
    projectId: args.projectId,
    itemId: args.itemId,
    fieldId: args.fieldId,
    value: valueVariable.val
  }
  const result = await runGraphql<unknown>(query, vars, projectGhExecOptions(args.host))
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

export async function clearProjectItemFieldValue(
  args: ClearProjectItemFieldArgs
): Promise<GitHubProjectMutationResult> {
  if (!args.projectId || !args.itemId || !args.fieldId) {
    return { ok: false, error: { type: 'validation_error', message: 'Missing ids.' } }
  }
  const result = await runGraphql<unknown>(
    `mutation($projectId:ID!, $itemId:ID!, $fieldId:ID!) {
       clearProjectV2ItemFieldValue(input: {
         projectId: $projectId itemId: $itemId fieldId: $fieldId
       }) { projectV2Item { id } }
     }`,
    { projectId: args.projectId, itemId: args.itemId, fieldId: args.fieldId },
    projectGhExecOptions(args.host)
  )
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}
