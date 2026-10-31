import {
  updateLinearIssueForAgent,
  LinearWriteFailure,
  writeIssueRelation
} from './runtime-linear-command-dependencies'
import { linearError } from '../linear/issue-context/errors'
import type {
  LinearCurrentIssueContextHints,
  LinearIssueRelationWriteRequest,
  LinearIssueRelationWriteResult,
  LinearStatusSetResult
} from './runtime-linear-command-dependencies'
import { RuntimeLinearSaveCommands } from './runtime-linear-save-commands'

export class RuntimeLinearStateCommands extends RuntimeLinearSaveCommands {
  async linearIssueSetState(
    params: {
      input?: string
      current?: boolean
      workspaceId?: string
      to: string
      context?: LinearCurrentIssueContextHints
    },
    cancellation?: AbortSignal
  ): Promise<LinearStatusSetResult> {
    const {
      owner: { target, state, previousState, alreadyInState }
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const teamId = target.issue.team?.id
        if (!teamId) {
          throw linearError('linear_invalid_state', 'The Linear issue does not have a team.')
        }
        const states = await this.getLinearTeamStatesForWrite(teamId, target.workspaceId, signal)
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
        return { target, state, previousState, alreadyInState }
      },
      async ({ target, state, alreadyInState }, options) => {
        if (alreadyInState) {
          return
        }
        const updated = await updateLinearIssueForAgent(
          target.issue.id,
          { stateId: state.id },
          target.workspaceId,
          {
            ...options
          }
        )
        if (updated.state?.id !== state.id) {
          throw new LinearWriteFailure('unconfirmed', 'Linear state update could not be confirmed.')
        }
        return updated
      },
      ({ target }, cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the state change, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --workspace ${target.workspaceId} --json\` and check the current state before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        ),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, target.issue.identifier)
    return {
      issue: this.linearWriteIssueRef(target.issue),
      state: { id: state.id, name: state.name, type: state.type },
      previousState,
      meta: { workspaceId: target.workspaceId, alreadyInState }
    }
  }

  async linearIssueRelationWrite(
    params: LinearIssueRelationWriteRequest,
    cancellation?: AbortSignal
  ): Promise<LinearIssueRelationWriteResult> {
    const {
      owner: { target, related },
      result
    } = await this.runLinearAgentAction(
      async (signal) => {
        const target = await this.resolveLinearAgentWriteTarget(params, signal)
        const related = await this.resolveLinearAgentWriteTarget(
          {
            input: params.relatedInput,
            workspaceId: target.workspaceId,
            context: params.context
          },
          signal
        )
        if (target.issue.id === related.issue.id) {
          throw linearError('linear_write_failed', 'An issue cannot be related to itself.')
        }
        return { target, related }
      },
      ({ target, related }, options) =>
        writeIssueRelation({
          issue: { ...this.linearWriteIssueRef(target.issue), title: target.issue.title },
          relatedIssue: {
            ...this.linearWriteIssueRef(related.issue),
            title: related.issue.title
          },
          relationship: params.relationship,
          operation: params.operation,
          workspaceId: target.workspaceId,
          ...options
        }),
      ({ target }, cause) =>
        linearError(
          'linear_write_unconfirmed',
          'Linear may have applied the relation change, but Orca could not confirm it.',
          {
            nextSteps: [
              `Run \`orca linear issue ${target.issue.identifier} --relations --workspace ${target.workspaceId} --json\` before retrying.`
            ],
            ...(cause ? { cause } : {})
          }
        ),
      cancellation
    )
    void this.notifyLinearLinkedIssueUpdated(target.workspaceId, [
      target.issue.identifier,
      related.issue.identifier
    ])
    return result
  }
}
