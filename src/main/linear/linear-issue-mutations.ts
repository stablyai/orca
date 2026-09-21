import type { LinearClient } from '@linear/sdk'
import type { LinearIssueUpdate } from '../../shared/issue-mutation-types'
import { acquire, release } from './linear-request-concurrency'
import { clearToken } from './linear-token-store'
import { getClients, isAuthError } from './client'
import {
  ISSUE_BY_UUID_QUERY,
  type LinearIssueByUuidResponse,
  type LinearRawVariables
} from './linear-issue-query-documents'
import {
  LinearWriteFailure,
  confirmLinearWrite,
  mapRawIssueWriteRecord,
  runLinearWrite,
  type LinearIssueWriteRecord
} from './linear-issue-write-support'

export async function createIssue(
  teamId: string,
  title: string,
  description?: string,
  workspaceId?: string | null,
  options?: {
    id?: string
    parentId?: string
    projectId?: string | null
    stateId?: string
    priority?: number
    estimate?: number | null
    dueDate?: string | null
    assigneeId?: string | null
    labelIds?: string[]
  }
): Promise<
  | { ok: true; id: string; identifier: string; title: string; url: string }
  | { ok: false; error: string }
> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    const result = await entry.client.createIssue({
      ...(options?.id ? { id: options.id } : {}),
      teamId,
      title,
      ...(description ? { description } : {}),
      ...(options?.parentId ? { parentId: options.parentId } : {}),
      ...(options?.projectId ? { projectId: options.projectId } : {}),
      ...(options?.stateId ? { stateId: options.stateId } : {}),
      ...(options?.priority !== undefined ? { priority: options.priority } : {}),
      ...(options?.estimate !== undefined ? { estimate: options.estimate } : {}),
      ...(options?.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
      ...(options?.assigneeId ? { assigneeId: options.assigneeId } : {}),
      ...(options?.labelIds ? { labelIds: options.labelIds } : {})
    })
    if (!result.success) {
      return { ok: false, error: 'Linear create failed' }
    }
    const issue = await result.issue
    if (!issue) {
      return { ok: false, error: 'Issue was created but could not be retrieved' }
    }
    return {
      ok: true,
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url
    }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function createIssueForAgent(
  teamId: string,
  title: string,
  description: string | undefined,
  workspaceId: string,
  options: {
    id: string
    parentId?: string | null
    projectId?: string | null
    stateId?: string
    assigneeId?: string | null
    priority?: number
    estimate?: number | null
    dueDate?: string | null
    labelIds?: string[]
    signal?: AbortSignal
  }
): Promise<LinearIssueWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const result = await client.createIssue({
      id: options.id,
      teamId,
      title,
      ...(description ? { description } : {}),
      ...(options.parentId ? { parentId: options.parentId } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {}),
      ...(options.stateId ? { stateId: options.stateId } : {}),
      ...(options.assigneeId !== undefined ? { assigneeId: options.assigneeId } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.estimate !== undefined ? { estimate: options.estimate } : {}),
      ...(options.dueDate !== undefined ? { dueDate: options.dueDate } : {}),
      ...(options.labelIds !== undefined ? { labelIds: options.labelIds } : {})
    })
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear create failed')
    }
    const issue = await confirmLinearWrite(
      'Issue was created but could not be retrieved',
      async () => result.issue
    )
    if (!issue?.id) {
      throw new LinearWriteFailure('unconfirmed', 'Issue was created but could not be retrieved')
    }
    return confirmLinearWrite('Issue was created but could not be retrieved', () =>
      getCreatedIssueRecord(issue.id, client)
    )
  })
}

async function getCreatedIssueRecord(
  issueId: string,
  client: LinearClient
): Promise<LinearIssueWriteRecord> {
  const result = await client.client.rawRequest<LinearIssueByUuidResponse, LinearRawVariables>(
    ISSUE_BY_UUID_QUERY,
    { id: issueId }
  )
  const record = result.data?.issue ?? null
  if (!record) {
    throw new LinearWriteFailure('unconfirmed', 'Issue was created but could not be retrieved')
  }
  return mapRawIssueWriteRecord(record)
}

export async function updateIssue(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId?: string | null
): Promise<{ ok: true } | { ok: false; error: string }> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    return { ok: false, error: 'Not connected to Linear' }
  }

  await acquire()
  try {
    // Why: labelIds is a full-replace field — a TOCTOU race exists if another
    // user changes labels between fetch and write. The caller passes the
    // complete set built from recently-fetched data. Acceptable for v1;
    // a future version could re-fetch right before writing or use webhooks.
    const resolvedLabelIds = updates.labelIds

    const payload: Record<string, unknown> = {}
    if (updates.stateId !== undefined) {
      payload.stateId = updates.stateId
    }
    if (updates.title !== undefined) {
      payload.title = updates.title
    }
    if (updates.description !== undefined) {
      payload.description = updates.description
    }
    if (updates.assigneeId !== undefined) {
      payload.assigneeId = updates.assigneeId
    }
    if (updates.estimate !== undefined) {
      payload.estimate = updates.estimate
    }
    if (updates.priority !== undefined) {
      payload.priority = updates.priority
    }
    if (updates.dueDate !== undefined) {
      payload.dueDate = updates.dueDate
    }
    if (resolvedLabelIds !== undefined) {
      payload.labelIds = resolvedLabelIds
    }
    if (updates.projectId !== undefined) {
      payload.projectId = updates.projectId
    }
    if (updates.parentId !== undefined) {
      payload.parentId = updates.parentId
    }

    const result = await entry.client.updateIssue(id, payload)
    if (!result.success) {
      return { ok: false, error: 'Linear update failed' }
    }
    return { ok: true }
  } catch (error) {
    if (isAuthError(error)) {
      clearToken(entry.workspace.id)
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

export async function updateIssueForAgent(
  id: string,
  updates: LinearIssueUpdate,
  workspaceId: string,
  options: { signal?: AbortSignal } = {}
): Promise<LinearIssueWriteRecord> {
  const entry = getClients(workspaceId)[0]
  if (!entry) {
    throw new LinearWriteFailure('failed', 'Not connected to Linear')
  }

  return runLinearWrite(entry, options.signal, async (client) => {
    const payload: Record<string, unknown> = {}
    if (updates.stateId !== undefined) {
      payload.stateId = updates.stateId
    }
    if (updates.title !== undefined) {
      payload.title = updates.title
    }
    if (updates.description !== undefined) {
      payload.description = updates.description
    }
    if (updates.assigneeId !== undefined) {
      payload.assigneeId = updates.assigneeId
    }
    if (updates.priority !== undefined) {
      payload.priority = updates.priority
    }
    if (updates.estimate !== undefined) {
      payload.estimate = updates.estimate
    }
    if (updates.dueDate !== undefined) {
      payload.dueDate = updates.dueDate
    }
    if (updates.labelIds !== undefined) {
      payload.labelIds = updates.labelIds
    }
    if (updates.projectId !== undefined) {
      payload.projectId = updates.projectId
    }
    if (updates.parentId !== undefined) {
      payload.parentId = updates.parentId
    }
    const result = await client.updateIssue(id, payload)
    if (!result.success) {
      throw new LinearWriteFailure('failed', 'Linear update failed')
    }
    return confirmLinearWrite('Issue was updated but could not be retrieved', () =>
      getCreatedIssueRecord(id, client)
    )
  })
}
