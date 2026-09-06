import type { MobileWebBridgeOperationName } from '../../shared/mobile-web/bridge-operation-registry'
import {
  MobileWebTaskProjectAssignableUsersPayloadSchema,
  MobileWebTaskProjectAssignableUsersResultSchema,
  MobileWebTaskProjectIssueTypesResultSchema,
  MobileWebTaskProjectItemDetailPayloadSchema,
  MobileWebTaskProjectItemDetailResultSchema,
  MobileWebTaskProjectLabelsResultSchema,
  MobileWebTaskProjectSlugPayloadSchema,
  type MobileWebTaskProjectAssignableUsersPayload,
  type MobileWebTaskProjectItemDetailPayload,
  type MobileWebTaskProjectSlugPayload
} from '../../shared/mobile-web/task-project-metadata-contract'
import {
  MobileWebTaskProjectTablePageResultSchema,
  MobileWebTaskProjectTablePayloadSchema,
  type MobileWebTaskProjectTablePayload
} from '../../shared/mobile-web/task-project-table-contract'
import {
  MobileWebTaskProjectListPayloadSchema,
  MobileWebTaskProjectListResultSchema,
  MobileWebTaskProjectResolvePayloadSchema,
  MobileWebTaskProjectResolveResultSchema,
  MobileWebTaskProjectViewsPayloadSchema,
  MobileWebTaskProjectViewsResultSchema,
  type MobileWebTaskProjectRef,
  type MobileWebTaskProjectResolvePayload
} from '../../shared/mobile-web/task-project-read-contract'
import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'
import { sameMobileWebTaskProject } from './mobile-web-task-project-identity'
import type { MobileWebOneShotRequestClient } from './mobile-web-one-shot-request-client'
import type { ZodType } from 'zod'
import {
  MobileWebTaskProjectCommentAddPayloadSchema,
  MobileWebTaskProjectCommentAddResultSchema,
  MobileWebTaskProjectCommentDeletePayloadSchema,
  MobileWebTaskProjectCommentUpdatePayloadSchema,
  MobileWebTaskProjectChecksPayloadSchema,
  MobileWebTaskProjectChecksResultSchema,
  MobileWebTaskProjectFieldUpdatePayloadSchema,
  MobileWebTaskProjectFileContentsPayloadSchema,
  MobileWebTaskProjectFileContentsResultSchema,
  MobileWebTaskProjectFileViewedPayloadSchema,
  MobileWebTaskProjectInlineCommentPayloadSchema,
  MobileWebTaskProjectIssueTypeUpdatePayloadSchema,
  MobileWebTaskProjectItemUpdatePayloadSchema,
  MobileWebTaskProjectMergePayloadSchema,
  MobileWebTaskProjectMetadataUpdatePayloadSchema,
  MobileWebTaskProjectMutationResultSchema,
  MobileWebTaskProjectConversationCommentPayloadSchema,
  MobileWebTaskProjectRerunChecksPayloadSchema,
  MobileWebTaskProjectReviewersPayloadSchema,
  MobileWebTaskProjectReviewReplyPayloadSchema,
  MobileWebTaskProjectReviewThreadPayloadSchema,
  type MobileWebTaskProjectCommentAddPayload,
  type MobileWebTaskProjectCommentDeletePayload,
  type MobileWebTaskProjectCommentUpdatePayload,
  type MobileWebTaskProjectChecksPayload,
  type MobileWebTaskProjectFieldUpdatePayload,
  type MobileWebTaskProjectFileContentsPayload,
  type MobileWebTaskProjectFileViewedPayload,
  type MobileWebTaskProjectInlineCommentPayload,
  type MobileWebTaskProjectIssueTypeUpdatePayload,
  type MobileWebTaskProjectItemUpdatePayload,
  type MobileWebTaskProjectMergePayload,
  type MobileWebTaskProjectMetadataUpdatePayload,
  type MobileWebTaskProjectConversationCommentPayload,
  type MobileWebTaskProjectRerunChecksPayload,
  type MobileWebTaskProjectReviewersPayload,
  type MobileWebTaskProjectReviewReplyPayload,
  type MobileWebTaskProjectReviewThreadPayload
} from '../../shared/mobile-web/task-project-mutation-contract'

export class MobileWebTaskProjectRequestClient {
  constructor(protected readonly requests: MobileWebOneShotRequestClient) {}

  listProjects(payload: { host: string }) {
    return this.requests
      .request(
        'task',
        'listProjects',
        payload,
        MobileWebTaskProjectListPayloadSchema,
        MobileWebTaskProjectListResultSchema
      )
      .then((result) => {
        if (result.projects.some((project) => project.host !== payload.host)) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  listProjectViews(payload: MobileWebTaskProjectRef) {
    return this.requests.request(
      'task',
      'listProjectViews',
      payload,
      MobileWebTaskProjectViewsPayloadSchema,
      MobileWebTaskProjectViewsResultSchema
    )
  }

  resolveProjectRef(payload: MobileWebTaskProjectResolvePayload) {
    return this.requests
      .request(
        'task',
        'resolveProjectRef',
        payload,
        MobileWebTaskProjectResolvePayloadSchema,
        MobileWebTaskProjectResolveResultSchema
      )
      .then((result) => {
        if (result.host !== undefined && result.host !== payload.host) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  projectTablePage(payload: MobileWebTaskProjectTablePayload) {
    return this.requests
      .request(
        'task',
        'projectTable',
        payload,
        MobileWebTaskProjectTablePayloadSchema,
        MobileWebTaskProjectTablePageResultSchema
      )
      .then((result) => {
        if (
          (result.project && !sameMobileWebTaskProject(result.project, payload)) ||
          (result.selectedView && result.selectedView.id !== payload.viewId)
        ) {
          throw new MobileWebBridgeClientError('invalid_message', false)
        }
        return result
      })
  }

  loadProjectItemDetail(payload: MobileWebTaskProjectItemDetailPayload) {
    return this.requests.request(
      'task',
      'projectItemDetail',
      payload,
      MobileWebTaskProjectItemDetailPayloadSchema,
      MobileWebTaskProjectItemDetailResultSchema
    )
  }

  listProjectItemLabels(payload: MobileWebTaskProjectSlugPayload) {
    return this.requests.request(
      'task',
      'projectItemLabels',
      payload,
      MobileWebTaskProjectSlugPayloadSchema,
      MobileWebTaskProjectLabelsResultSchema
    )
  }

  listProjectItemAssignableUsers(payload: MobileWebTaskProjectAssignableUsersPayload) {
    return this.requests.request(
      'task',
      'projectItemAssignableUsers',
      payload,
      MobileWebTaskProjectAssignableUsersPayloadSchema,
      MobileWebTaskProjectAssignableUsersResultSchema
    )
  }

  listProjectIssueTypes(payload: MobileWebTaskProjectSlugPayload) {
    return this.requests.request(
      'task',
      'projectIssueTypes',
      payload,
      MobileWebTaskProjectSlugPayloadSchema,
      MobileWebTaskProjectIssueTypesResultSchema
    )
  }

  updateProjectItem(payload: MobileWebTaskProjectItemUpdatePayload) {
    return this.mutate('updateProjectItem', payload, MobileWebTaskProjectItemUpdatePayloadSchema)
  }

  addProjectComment(payload: MobileWebTaskProjectCommentAddPayload) {
    return this.requests.request(
      'task',
      'addProjectComment',
      payload,
      MobileWebTaskProjectCommentAddPayloadSchema,
      MobileWebTaskProjectCommentAddResultSchema
    )
  }

  updateProjectComment(payload: MobileWebTaskProjectCommentUpdatePayload) {
    return this.mutate(
      'updateProjectComment',
      payload,
      MobileWebTaskProjectCommentUpdatePayloadSchema
    )
  }

  deleteProjectComment(payload: MobileWebTaskProjectCommentDeletePayload) {
    return this.mutate(
      'deleteProjectComment',
      payload,
      MobileWebTaskProjectCommentDeletePayloadSchema
    )
  }

  updateProjectMetadata(payload: MobileWebTaskProjectMetadataUpdatePayload) {
    return this.mutate(
      'updateProjectMetadata',
      payload,
      MobileWebTaskProjectMetadataUpdatePayloadSchema
    )
  }

  updateProjectField(payload: MobileWebTaskProjectFieldUpdatePayload) {
    return this.mutate('updateProjectField', payload, MobileWebTaskProjectFieldUpdatePayloadSchema)
  }

  updateProjectIssueType(payload: MobileWebTaskProjectIssueTypeUpdatePayload) {
    return this.mutate(
      'updateProjectIssueType',
      payload,
      MobileWebTaskProjectIssueTypeUpdatePayloadSchema
    )
  }

  resolveProjectReviewThread(payload: MobileWebTaskProjectReviewThreadPayload) {
    return this.mutate(
      'resolveProjectReviewThread',
      payload,
      MobileWebTaskProjectReviewThreadPayloadSchema
    )
  }

  replyProjectReviewComment(payload: MobileWebTaskProjectReviewReplyPayload) {
    return this.mutate(
      'replyProjectReviewComment',
      payload,
      MobileWebTaskProjectReviewReplyPayloadSchema
    )
  }

  addProjectConversationComment(payload: MobileWebTaskProjectConversationCommentPayload) {
    return this.mutate(
      'addProjectConversationComment',
      payload,
      MobileWebTaskProjectConversationCommentPayloadSchema
    )
  }

  requestProjectReviewers(payload: MobileWebTaskProjectReviewersPayload) {
    return this.mutate(
      'requestProjectReviewers',
      payload,
      MobileWebTaskProjectReviewersPayloadSchema
    )
  }

  rerunProjectChecks(payload: MobileWebTaskProjectRerunChecksPayload) {
    return this.mutate('rerunProjectChecks', payload, MobileWebTaskProjectRerunChecksPayloadSchema)
  }

  mergeProjectPullRequest(payload: MobileWebTaskProjectMergePayload) {
    return this.mutate('mergeProjectPullRequest', payload, MobileWebTaskProjectMergePayloadSchema)
  }

  private mutate(
    operation: MobileWebBridgeOperationName<'task'>,
    payload: unknown,
    payloadSchema: ZodType
  ) {
    return this.requests.request(
      'task',
      operation,
      payload,
      payloadSchema,
      MobileWebTaskProjectMutationResultSchema
    )
  }

  refreshProjectChecks(payload: MobileWebTaskProjectChecksPayload) {
    return this.requests.request(
      'task',
      'refreshProjectChecks',
      payload,
      MobileWebTaskProjectChecksPayloadSchema,
      MobileWebTaskProjectChecksResultSchema
    )
  }

  setProjectFileViewed(payload: MobileWebTaskProjectFileViewedPayload) {
    return this.mutate('setProjectFileViewed', payload, MobileWebTaskProjectFileViewedPayloadSchema)
  }

  loadProjectFileContents(payload: MobileWebTaskProjectFileContentsPayload) {
    return this.requests.request(
      'task',
      'loadProjectFileContents',
      payload,
      MobileWebTaskProjectFileContentsPayloadSchema,
      MobileWebTaskProjectFileContentsResultSchema
    )
  }

  addProjectInlineComment(payload: MobileWebTaskProjectInlineCommentPayload) {
    return this.requests.request(
      'task',
      'addProjectInlineComment',
      payload,
      MobileWebTaskProjectInlineCommentPayloadSchema,
      MobileWebTaskProjectCommentAddResultSchema
    )
  }
}
