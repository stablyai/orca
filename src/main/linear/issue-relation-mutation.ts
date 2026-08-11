import type { LinearClient } from '@linear/sdk'
import type { RawRelationNode } from './issue-context-raw'
import { isAuthError } from './client'
import { classifyLinearWriteFailure, LinearWriteFailure } from './issues'

type RelationMutationResponse = {
  issueRelationCreate?: {
    success?: boolean
    issueRelation?: RawRelationNode | null
  } | null
  issueRelationDelete?: { success?: boolean } | null
}

const CREATE_RELATION_MUTATION = `
  mutation OrcaLinearCreateIssueRelation($input: IssueRelationCreateInput!) {
    issueRelationCreate(input: $input) {
      success
      issueRelation {
        id
        type
        issue { id identifier title url }
        relatedIssue { id identifier title url }
      }
    }
  }
`

const DELETE_RELATION_MUTATION = `
  mutation OrcaLinearDeleteIssueRelation($id: String!) {
    issueRelationDelete(id: $id) { success }
  }
`

export async function createLinearIssueRelation(
  client: LinearClient,
  input: { issueId: string; relatedIssueId: string; type: string }
): Promise<RawRelationNode> {
  const raw = await runRelationMutation(() =>
    client.client.rawRequest<RelationMutationResponse, Record<string, unknown>>(
      CREATE_RELATION_MUTATION,
      { input }
    )
  )
  const created = raw.data?.issueRelationCreate
  if (created?.success !== true || !created.issueRelation) {
    throw new LinearWriteFailure('failed', 'Linear relation creation failed')
  }
  return created.issueRelation
}

export async function deleteLinearIssueRelation(
  client: LinearClient,
  relationId: string
): Promise<void> {
  const raw = await runRelationMutation(() =>
    client.client.rawRequest<RelationMutationResponse, Record<string, unknown>>(
      DELETE_RELATION_MUTATION,
      { id: relationId }
    )
  )
  if (raw.data?.issueRelationDelete?.success !== true) {
    throw new LinearWriteFailure('failed', 'Linear relation removal failed')
  }
}

async function runRelationMutation<T>(mutation: () => Promise<T>): Promise<T> {
  try {
    return await mutation()
  } catch (error) {
    if (isAuthError(error)) {
      throw error
    }
    const failure = classifyLinearWriteFailure(error)
    if (failure.kind === 'duplicate_id') {
      // Why: relation creates have no caller-supplied id, so a duplicate can be a concurrent add.
      throw new LinearWriteFailure(
        'unconfirmed',
        'Linear relation mutation could not be confirmed.',
        error
      )
    }
    throw failure
  }
}
