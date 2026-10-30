import {
  randomUUID,
  LINEAR_WRITE_BODY_CAP,
  createLinearIssueForAgent,
  LinearWriteFailure
} from './runtime-linear-command-dependencies'
import { linearError } from '../linear/issue-context/errors'
import type {
  LinearCurrentIssueContextHints,
  LinearCreateResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearSaveFieldCommands } from './runtime-linear-save-fields-commands'

export class RuntimeLinearCreateCommands extends RuntimeLinearSaveFieldCommands {
  async linearIssueCreate(
    params: {
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
    },
    cancellation?: AbortSignal
  ): Promise<LinearCreateResult> {
    if ((params.body?.length ?? 0) > LINEAR_WRITE_BODY_CAP) {
      throw linearError('linear_body_too_large', 'Linear issue body is too large.')
    }
    const writeId = params.writeId ?? randomUUID()
    const {
      owner: { team, parent },
      result
    } = await this.runLinearAgentAction(
      async (signal) => {
        const parent =
          params.parentInput || params.parentCurrent
            ? await this.resolveLinearAgentWriteTarget(
                {
                  input: params.parentInput,
                  current: params.parentCurrent,
                  workspaceId: params.workspaceId,
                  context: params.context
                },
                signal
              )
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
          parent,
          signal
        )
        const createFields = await this.resolveLinearCreateFields(params, team, signal)
        const parentId = parent?.issue.id ?? null
        const existing =
          params.writeId !== undefined
            ? await this.getMatchingLinearCreatedIssue(
                writeId,
                team.id,
                parentId,
                team.workspaceId,
                true,
                createFields,
                signal
              )
            : null
        return { team, parent, parentId, createFields, existing }
      },
      async ({ team, parent, parentId, createFields, existing }, options) => {
        if (existing) {
          return { issue: existing, deduplicated: true }
        }

        try {
          const issue = await createLinearIssueForAgent(
            team.id,
            params.title,
            params.body,
            team.workspaceId,
            {
              id: writeId,
              parentId,
              ...createFields,
              ...options
            }
          )
          if (!this.linearCreatedIssueMatchesIntent(issue, createFields)) {
            throw new LinearWriteFailure(
              'unconfirmed',
              'Linear issue create could not be confirmed with the requested task fields.'
            )
          }
          return { issue, deduplicated: false }
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
                }),
              options.signal
            )
            return { issue, deduplicated: true }
          }
          throw error
        }
      },
      ({ team, parent, createFields }, cause) =>
        this.linearCreateStyleUnconfirmed('create', writeId, null, {
          team,
          parent,
          title: params.title,
          bodyRequired: params.body !== undefined,
          createFields,
          cause
        }),
      cancellation
    )
    if (parent) {
      this.notifyLinearLinkedIssueUpdated(parent.workspaceId, parent.issue.identifier)
    }
    return this.linearCreateResult(result.issue, team.workspaceId, writeId, result.deduplicated)
  }
}
