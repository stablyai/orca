import type {
  ItsaplanComment,
  ItsaplanCreateIssueArgs,
  ItsaplanFailure,
  ItsaplanIssue,
  ItsaplanIssueUpdate,
  ItsaplanProjectMetadata,
  ItsaplanResult
} from '../../shared/itsaplan/itsaplan-types'
import { ItsaplanApiError, itsaplanRequest } from './client'
import {
  mapItsaplanComment,
  mapItsaplanIssue,
  type ItsaplanRawFeedItem,
  type ItsaplanRawIssue
} from './itsaplan-issue-mapping'
import { requireItsaplanAppUrl } from './itsaplan-issue-read'
import { itsaplanGetProjectMetadata, resolveItsaplanProjectRef } from './itsaplan-project-queries'

type RawCreatedIssue = ItsaplanRawIssue & { projectId: number }

function toFailure(error: unknown): ItsaplanFailure {
  if (error instanceof ItsaplanApiError) {
    return { ok: false, error: error.code, message: error.message }
  }
  return { ok: false, error: 'requestFailed', message: 'requestFailed: The request failed.' }
}

// The API requires a column on create; start in the first open state.
function defaultCreateColumnId(metadata: ItsaplanProjectMetadata): number {
  const ordered = [...metadata.columns].sort((a, b) => a.position - b.position)
  const column =
    ordered.find((c) => c.stateType === 'unstarted') ??
    ordered.find((c) => c.stateType === 'backlog') ??
    ordered[0]
  if (!column) {
    throw new ItsaplanApiError('requestFailed', null, 'The project has no columns.')
  }
  return column.id
}

export async function itsaplanCreateIssue(
  args: ItsaplanCreateIssueArgs
): Promise<ItsaplanResult<{ issue: ItsaplanIssue }>> {
  try {
    const appUrl = await requireItsaplanAppUrl()
    const metadata = await itsaplanGetProjectMetadata({ projectRef: args.projectRef })
    const raw = await itsaplanRequest<RawCreatedIssue>(
      `/projects/${encodeURIComponent(args.projectRef)}/issues`,
      {
        method: 'POST',
        body: {
          title: args.title,
          description: args.description,
          columnId: args.columnId ?? defaultCreateColumnId(metadata),
          priority: args.priority,
          labelIds: args.labelIds,
          assigneeUserId: args.assigneeUserId,
          parentId: args.parentId
        }
      }
    )
    return { ok: true, issue: mapItsaplanIssue(raw, { metadata, appUrl }) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function itsaplanUpdateIssue(args: {
  issueId: number
  projectRef?: string
  updates: ItsaplanIssueUpdate
}): Promise<ItsaplanResult<{ issue: ItsaplanIssue }>> {
  try {
    const appUrl = await requireItsaplanAppUrl()
    const raw = await itsaplanRequest<RawCreatedIssue>(`/issues/${args.issueId}`, {
      method: 'PATCH',
      body: args.updates
    })
    const projectRef = await resolveItsaplanProjectRef(raw.projectId, args.projectRef)
    const metadata = await itsaplanGetProjectMetadata({ projectRef })
    return { ok: true, issue: mapItsaplanIssue(raw, { metadata, appUrl }) }
  } catch (error) {
    return toFailure(error)
  }
}

export async function itsaplanAddComment(args: {
  issueId: number
  body: string
}): Promise<ItsaplanResult<{ comment: ItsaplanComment }>> {
  try {
    const raw = await itsaplanRequest<ItsaplanRawFeedItem>(`/issues/${args.issueId}/comments`, {
      method: 'POST',
      body: { body: args.body }
    })
    const comment = mapItsaplanComment(raw)
    if (!comment) {
      throw new ItsaplanApiError('requestFailed', null, 'Unexpected response.')
    }
    return { ok: true, comment }
  } catch (error) {
    return toFailure(error)
  }
}
