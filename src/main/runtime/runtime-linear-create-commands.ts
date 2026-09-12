import {
  randomUUID,
  LINEAR_WRITE_BODY_CAP,
  createLinearIssueForAgent,
  LinearWriteFailure,
  linearError
} from './runtime-linear-command-dependencies'
import type {
  LinearCurrentIssueContextHints,
  LinearCreateResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearSaveFieldCommands } from './runtime-linear-save-fields-commands'

export class RuntimeLinearCreateCommands extends RuntimeLinearSaveFieldCommands {
  async linearIssueCreate(params: {
    title: string
    body?: string
    teamInput?: string
    teamKey?: string
    state?: string
    assignee?: string
    priority?: number
    estimate?: number
    dueDate?: string
    labels?: string[]
    projectInput?: string
    parentInput?: string
    parentCurrent?: boolean
    workspaceId?: string
    writeId?: string
    context?: LinearCurrentIssueContextHints
  }): Promise<LinearCreateResult> {
    if ((params.body?.length ?? 0) > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear issue body is too large.')
    }
    const parent =
      params.parentInput || params.parentCurrent
        ? await this.resolveLinearAgentWriteTarget({
            input: params.parentInput,
            current: params.parentCurrent,
            workspaceId: params.workspaceId,
            context: params.context
          })
        : null
    if (parent && params.workspaceId && params.workspaceId !== parent.workspaceId) {
      throw linearError(
        'linear_invalid_workspace',
        'The parent issue belongs to a different workspace.'
      )
    }
    const team = await this.resolveLinearCreateTeam(
      params.teamInput ?? params.teamKey,
      params.workspaceId,
      parent
    )
    const createFields = await this.resolveLinearCreateFields(params, team)
    const parentId = parent?.issue.id ?? null
    const writeId = params.writeId ?? randomUUID()
    const existing =
      params.writeId !== undefined
        ? await this.getMatchingLinearCreatedIssue(
            writeId,
            team.id,
            parentId,
            team.workspaceId,
            true,
            createFields
          )
        : null
    if (existing) {
      if (parent) {
        await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
      }
      return this.linearCreateResult(existing, team.workspaceId, writeId, true)
    }

    try {
      const issue = await this.runLinearAgentWrite(
        async (signal) => {
          const created = await createLinearIssueForAgent(
            team.id,
            params.title,
            params.body,
            team.workspaceId,
            {
              id: writeId,
              parentId,
              ...createFields,
              signal
            }
          )
          if (!this.linearCreatedIssueMatchesIntent(created, createFields)) {
            throw new LinearWriteFailure(
              'unconfirmed',
              'Linear issue create could not be confirmed with the requested task fields.'
            )
          }
          return created
        },
        (cause) =>
          this.linearCreateStyleUnconfirmed('create', writeId, null, {
            team,
            parent,
            title: params.title,
            bodyRequired: params.body !== undefined,
            createFields,
            cause
          })
      )
      if (parent) {
        await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
      }
      return this.linearCreateResult(issue, team.workspaceId, writeId, false)
    } catch (error) {
      if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
        const issue = await this.refetchLinearIssueAfterDuplicate(
          writeId,
          team.id,
          parentId,
          team.workspaceId,
          createFields,
          () =>
            this.linearCreateStyleUnconfirmed('create', writeId, null, {
              team,
              parent,
              title: params.title,
              bodyRequired: params.body !== undefined,
              createFields
            })
        )
        if (parent) {
          await this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
        }
        return this.linearCreateResult(issue, team.workspaceId, writeId, true)
      }
      throw error
    }
  }
}
