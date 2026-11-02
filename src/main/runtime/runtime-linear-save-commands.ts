import {
  LINEAR_WRITE_BODY_CAP,
  updateLinearIssueForAgent,
  LinearWriteFailure
} from './runtime-linear-command-dependencies'
import { linearError } from '../linear/issue-context/errors'
import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearSaveIssueRequest,
  LinearSaveIssueResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCommentCommands } from './runtime-linear-comment-commands'

export class RuntimeLinearSaveCommands extends RuntimeLinearCommentCommands {
  async linearSaveIssue(
    params: LinearSaveIssueRequest,
    cancellation?: AbortSignal
  ): Promise<LinearSaveIssueResult> {
    if ((params.description?.length ?? 0) > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear issue body is too large.')
    }
    if (!params.input && !params.current) {
      if (!params.title || !params.team) {
        throw linearError(
          'linear_write_failed',
          'Creating with save-issue requires both team and title.'
        )
      }
      const created = await this.linearIssueCreate(
        {
          title: params.title,
          body: params.description,
          teamInput: params.team,
          state: params.state,
          assignee: params.assignee ?? undefined,
          priority: params.priority,
          estimate: params.estimate ?? undefined,
          dueDate: params.dueDate ?? undefined,
          labels: params.labels,
          projectInput: params.project ?? undefined,
          parentInput: params.parentId ?? undefined,
          workspaceId: params.workspaceId,
          writeId: params.writeId,
          context: params.context
        },
        cancellation
      )
      return { ...created, meta: { ...created.meta, created: true } }
    }
    if (params.team !== undefined) {
      throw linearError('linear_write_failed', 'Team can only be set when creating an issue.')
    }
    const {
      owner: { target },
      result: updated
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const current = await this.readLinearAgentIssueWriteRecord(
          target.issue.id,
          target.workspaceId,
          signal
        )
        const fields = await this.buildLinearSaveUpdate(params, current, target.workspaceId, signal)
        if (Object.keys(fields).length === 0) {
          throw linearError('linear_write_failed', 'No issue fields were provided to save.')
        }
        const alreadySet = await this.linearSavedIssueMatchesIntent(current, fields)
        return { target, current, fields, alreadySet }
      },
      async ({ target, current, fields, alreadySet }, options) => {
        if (alreadySet) {
          return current
        }
        const saved = await updateLinearIssueForAgent(
          target.issue.id,
          fields,
          target.workspaceId,
          options
        )
        if (!(await this.linearSavedIssueMatchesIntent(saved, fields))) {
          throw new LinearWriteFailure('unconfirmed', 'Linear issue save could not be confirmed.')
        }
        return saved
      },
      ({ target }, cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the issue save, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        ),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return {
      issue: updated,
      meta: {
        workspaceId: target.workspaceId,
        created: false
      }
    }
  }

  async linearIssueUpdateTask(
    params: LinearIssueTaskUpdateRequest,
    cancellation?: AbortSignal
  ): Promise<LinearIssueTaskUpdateResult> {
    const {
      owner: { target, current, alreadySet },
      result: finalRecord
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const current = await this.readLinearAgentIssueWriteRecord(
          target.issue.id,
          target.workspaceId,
          signal
        )
        const update = await this.buildLinearTaskUpdate(params, current, target.workspaceId, signal)
        if (!update) {
          throw linearError('linear_write_failed', 'No Linear task field update was requested.')
        }
        const alreadySet = this.linearTaskFieldAlreadySet(params.operation, current, update)
        return { target, current, update, alreadySet }
      },
      async ({ target, current, update, alreadySet }, options) => {
        if (alreadySet) {
          return current
        }
        const updated = await updateLinearIssueForAgent(
          target.issue.id,
          update.fields,
          target.workspaceId,
          options
        )
        if (!this.linearTaskFieldAlreadySet(params.operation, updated, update)) {
          throw new LinearWriteFailure(
            'unconfirmed',
            'Linear task field update could not be confirmed.'
          )
        }
        return updated
      },
      ({ target }, cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the task update, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the updated field before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        ),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return this.linearTaskUpdateResult(
      params.operation,
      target.issue,
      target.workspaceId,
      current,
      finalRecord,
      alreadySet
    )
  }
}
