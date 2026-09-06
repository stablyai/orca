import {
  LINEAR_WRITE_BODY_CAP,
  updateLinearIssueForAgent,
  LinearWriteFailure,
  linearError
} from './runtime-linear-command-dependencies'
import type {
  LinearIssueTaskUpdateRequest,
  LinearIssueTaskUpdateResult,
  LinearSaveIssueRequest,
  LinearSaveIssueResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearCommentCommands } from './runtime-linear-comment-commands'

export class RuntimeLinearSaveCommands extends RuntimeLinearCommentCommands {
  async linearSaveIssue(params: LinearSaveIssueRequest): Promise<LinearSaveIssueResult> {
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
      const created = await this.linearIssueCreate({
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
      })
      return { ...created, meta: { ...created.meta, created: true } }
    }
    if (params.team !== undefined) {
      throw linearError('linear_write_failed', 'Team can only be set when creating an issue.')
    }
    const target = await this.resolveLinearAgentWriteTarget(params)
    const current = await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
    const fields = await this.buildLinearSaveUpdate(params, current, target.workspaceId)
    if (Object.keys(fields).length === 0) {
      throw linearError('linear_write_failed', 'No issue fields were provided to save.')
    }
    const alreadySet = this.linearSavedIssueMatchesIntent(current, fields)
    const updated = alreadySet
      ? current
      : await this.runLinearAgentWrite(
          async (signal) => {
            const saved = await updateLinearIssueForAgent(
              target.issue.id,
              fields,
              target.workspaceId,
              { signal }
            )
            if (!this.linearSavedIssueMatchesIntent(saved, fields)) {
              throw new LinearWriteFailure(
                'unconfirmed',
                'Linear issue save could not be confirmed.'
              )
            }
            return saved
          },
          (cause) =>
            linearError(
              'linear_write_unconfirmed',
              'Linear may have applied the issue save, but Orca could not confirm it.',
              {
                nextSteps: [
                  `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` before retrying.`
                ],
                ...(cause ? { cause } : {})
              }
            )
        )
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return {
      issue: updated,
      meta: {
        workspaceId: target.workspaceId,
        created: false
      }
    }
  }

  async linearIssueUpdateTask(
    params: LinearIssueTaskUpdateRequest
  ): Promise<LinearIssueTaskUpdateResult> {
    const target = await this.resolveLinearAgentWriteTarget(params)
    const current = await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
    const update = await this.buildLinearTaskUpdate(params, current, target.workspaceId)
    if (!update) {
      throw linearError('linear_write_failed', 'No Linear task field update was requested.')
    }
    const alreadySet = this.linearTaskFieldAlreadySet(params.operation, current, update)
    if (!alreadySet) {
      await this.runLinearAgentWrite(
        async (signal) => {
          const updated = await updateLinearIssueForAgent(
            target.issue.id,
            update.fields,
            target.workspaceId,
            { signal }
          )
          if (!this.linearTaskFieldAlreadySet(params.operation, updated, update)) {
            throw new LinearWriteFailure(
              'unconfirmed',
              'Linear task field update could not be confirmed.'
            )
          }
          return updated
        },
        (cause) =>
          linearError(
            'linear_write_unconfirmed',
            'Linear may have applied the task update, but Orca could not confirm it.',
            {
              nextSteps: [
                `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the updated field before retrying.`
              ],
              ...(cause ? { cause } : {})
            }
          )
      )
    }
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    const finalRecord = alreadySet
      ? current
      : await this.readLinearAgentIssueWriteRecord(target.issue.id, target.workspaceId)
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
