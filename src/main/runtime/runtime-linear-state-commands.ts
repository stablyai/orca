import {
  updateLinearIssueForAgent,
  LinearWriteFailure,
  linearError,
  writeIssueRelation
} from './runtime-linear-command-dependencies'
import type {
  LinearCurrentIssueContextHints,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult,
  LinearStatusSetResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearSaveCommands } from './runtime-linear-save-commands'

export class RuntimeLinearStateCommands extends RuntimeLinearSaveCommands {
  async linearIssueSetState(params: {
    input?: string
    current?: boolean
    workspaceId?: string
    to: string
    context?: LinearCurrentIssueContextHints
  }): Promise<LinearStatusSetResult> {
    const target = await this.resolveLinearAgentWriteTarget(params)
    const teamId = target.issue.team?.id
    if (!teamId) {
      throw linearError('linear_invalid_state', 'The Linear issue does not have a team.')
    }
    const states = await this.getLinearTeamStatesForWrite(teamId, target.workspaceId)
    const state = this.resolveLinearAgentState(params.to, states)
    if (!state) {
      throw linearError(
        'linear_invalid_state',
        `No workflow state exactly matched "${params.to}".`,
        {
          states: states.map(({ id, name, type }) => ({ id, name, type })),
          nextSteps: [`Retry with one of the exact state names for ${target.issue.identifier}.`]
        }
      )
    }

    const previousState =
      target.issue.state?.id && target.issue.state.name
        ? { id: target.issue.state.id, name: target.issue.state.name }
        : null
    const alreadyInState = target.issue.state?.id === state.id
    if (!alreadyInState) {
      await this.runLinearAgentWrite(
        async (signal) => {
          const updated = await updateLinearIssueForAgent(
            target.issue.id,
            { stateId: state.id },
            target.workspaceId,
            {
              signal
            }
          )
          if (updated.state?.id !== state.id) {
            throw new LinearWriteFailure(
              'unconfirmed',
              'Linear state update could not be confirmed.'
            )
          }
          return updated
        },
        (cause) =>
          linearError(
            'linear_write_unconfirmed',
            'Linear may have applied the state change, but Orca could not confirm it.',
            {
              nextSteps: [
                `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the current state before retrying.`
              ],
              ...(cause ? { cause } : {})
            }
          )
      )
    }
    await this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return {
      issue: this.linearWriteIssueRef(target.issue),
      state: { id: state.id, name: state.name, type: state.type },
      previousState,
      meta: { workspaceId: target.workspaceId, alreadyInState }
    }
  }

  async linearIssueRelationWrite(
    params: LinearIssueRelationWriteRequest
  ): Promise<LinearIssueRelationWriteResult> {
    const target = await this.resolveLinearAgentWriteTarget(params)
    const related = await this.resolveLinearAgentWriteTarget({
      input: params.relatedInput,
      workspaceId: target.workspaceId,
      context: params.context
    })
    if (target.issue.id === related.issue.id) {
      throw linearError('linear_write_failed', 'An issue cannot be related to itself.')
    }
    try {
      const result = await this.runLinearAgentWrite(
        (signal) =>
          writeIssueRelation({
            issue: { ...this.linearWriteIssueRef(target.issue), title: target.issue.title },
            relatedIssue: {
              ...this.linearWriteIssueRef(related.issue),
              title: related.issue.title
            },
            relationship: params.relationship,
            operation: params.operation,
            workspaceId: target.workspaceId,
            signal
          }),
        (cause) =>
          linearError(
            'linear_write_unconfirmed',
            'Linear may have applied the relation change, but Orca could not confirm it.',
            {
              nextSteps: [
                `Run \`orca linear issue ${target.issue.identifier} --relations --workspace ${target.workspaceId} --json\` before retrying.`
              ],
              ...(cause ? { cause } : {})
            }
          )
      )
      await this.notifyLinearLinkedIssueUpdated(target.workspaceId, [
        target.issue.identifier,
        related.issue.identifier
      ])
      return result
    } catch (error) {
      throw this.mapLinearReadFailure(error)
    }
  }
}
