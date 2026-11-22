// The owner's `orca linear` on the stand-in host: reads and writes the shared Linear world
// (bot-automation-eval-linear-world.json) as the owner, each write recorded under its runtime
// method. With no Linear login or key on the host, every call answers as the runtime does.
import { RuntimeClientError } from '../runtime/connection/types'
import { linearNotConnectedError } from '../../main/linear/issues/context/linear-not-connected-error'
import { WAKING_PLACE_REFUSAL } from '../../main/bots/bot-owner-writes'
import type { EvalHostState } from './bot-automation-eval-host'
import {
  linearIssue,
  linearTeam,
  ownerLinearIssue,
  searchLinear,
  teamRef,
  type LinearIssue
} from './bot-automation-eval-linear'
import { createLinear, setLinear } from './bot-automation-eval-linear-writes'
import { CONNECTOR_PRIORITIES } from '../../shared/connector-action-contract'
import type { StandInIo } from '../bot-orchestration-eval/bot-orchestration-eval-orca'
import WORLD from './bot-automation-eval-linear-world.json'

const OWNER = WORLD.members.find((member) => member.id === WORLD.ownerId)!
const workspace = { workspaceId: WORLD.workspaceId }
const issueUrl = (issue: LinearIssue) => `https://linear.app/eval/issue/${issue.identifier}`
const writeRef = (issue: LinearIssue) => ({
  id: issue.id,
  identifier: issue.identifier,
  url: issueUrl(issue)
})

function issueOrThrow(state: EvalHostState, input: unknown): LinearIssue {
  const issue = linearIssue(String(input ?? ''), state.linearRun)
  if (!issue) {
    throw new RuntimeClientError('not_found', 'Linear issue not found.')
  }
  return issue
}

function refusedOrThrow(answer: { ok: boolean; message?: string }): void {
  if (!answer.ok) {
    throw new RuntimeClientError('invalid_argument', answer.message ?? 'Linear refused the change.')
  }
}

/** Sets fields on an issue as the owner, keeping the change in the run like the connector's set. */
function set(
  state: EvalHostState,
  issue: LinearIssue,
  fields: Parameters<typeof setLinear>[1],
  io: StandInIo
): LinearIssue {
  const { answer, change } = setLinear(issue, fields, state.linearRun)
  refusedOrThrow(answer)
  const changes = state.linearRun?.changes
  state.linearRun = {
    ...state.linearRun,
    changes: {
      ...changes,
      [issue.identifier]: { ...changes?.[issue.identifier], ...change }
    }
  }
  io.save(state)
  return linearIssue(issue.identifier, state.linearRun)!
}

const LINEAR_WRITES = new Set([
  'linear.issueAddComment',
  'linear.issueSetState',
  'linear.issueUpdateTask',
  'linear.issueCreate',
  'linear.saveIssue',
  'linear.issueAttach',
  'linear.issueRelationWrite',
  'linear.commentEdit',
  'linear.commentDelete'
])

/** `orca linear`'s runtime methods; undefined for any other method. */
export function serveOwnerLinear(
  state: EvalHostState,
  method: string,
  params: Record<string, unknown>,
  io: StandInIo
): unknown {
  if (!method.startsWith('linear.')) {
    return undefined
  }
  if (state.linearSignedOut) {
    const error = linearNotConnectedError()
    throw new RuntimeClientError(error.code, error.message, error.data)
  }
  const target = () => issueOrThrow(state, params.input)
  // Recorded as grading reads a write (ConnectorVerdict): the issue it reached, and its state after.
  const recordWrite = <T>(issue: LinearIssue, answer: T, after?: LinearIssue): T => {
    io.record({
      kind: 'write',
      method,
      params,
      result: { target: issue.identifier, ...(after ? { state: after.state } : {}) }
    })
    return answer
  }
  switch (method) {
    case 'linear.issueContext': {
      const issue = ownerLinearIssue(String(params.input ?? ''), state.linearRun)
      if (!issue) {
        throw new RuntimeClientError('not_found', 'Linear issue not found.')
      }
      return { issue, meta: { sections: {}, includeErrors: [] } }
    }
    case 'linear.agentSearchIssues': {
      const found = searchLinear(
        `linear:${WORLD.workspaceId}:workspace`,
        { text: String(params.query ?? '') },
        Number(params.limit ?? 20),
        state.linearRun
      )
      const matches = 'result' in found ? found.result.matches : []
      return {
        issues: matches.flatMap((match) => {
          const issue = ownerLinearIssue(match.ref, state.linearRun)
          return issue ? [issue] : []
        }),
        meta: {
          query: String(params.query ?? ''),
          limit: Number(params.limit ?? 20),
          returned: matches.length,
          limitReached: false,
          partial: false,
          workspaceErrors: []
        }
      }
    }
    case 'linear.mcpListIssues': {
      const team = params.team ? linearTeam(String(params.team)) : undefined
      if (params.team && !team) {
        throw new RuntimeClientError('not_found', 'Linear team not found.')
      }
      const assignee = params.assignee === 'me' ? OWNER.name : params.assignee
      const found = searchLinear(
        team ? teamRef(team) : `linear:${WORLD.workspaceId}:workspace`,
        {
          ...(params.query ? { text: String(params.query) } : {}),
          ...(params.state ? { state: String(params.state) } : {}),
          ...(assignee ? { assignee: String(assignee) } : {}),
          ...(params.label ? { label: String(params.label) } : {})
        },
        Number(params.limit ?? 50),
        state.linearRun
      )
      if (!('result' in found)) {
        throw new RuntimeClientError('invalid_argument', found.message)
      }
      const issues = found.result.matches.flatMap((match) => {
        const issue = ownerLinearIssue(match.ref, state.linearRun)
        return issue
          ? [
              {
                ...issue,
                labels: issue.labels.map((name) => ({ name })),
                workspace: { id: WORLD.workspaceId, name: WORLD.workspaceName }
              }
            ]
          : []
      })
      return {
        issues,
        truncated: false,
        meta: {
          limit: null,
          returned: issues.length,
          hasMore: false,
          orderBy: 'updatedAt',
          partial: false,
          workspaceErrors: []
        }
      }
    }
    case 'linear.agentTeamList':
      return {
        teams: WORLD.teams.map((team) => ({ id: team.id, name: team.name, key: team.key })),
        meta: { returned: WORLD.teams.length, partial: false, workspaceErrors: [] }
      }
    case 'linear.issueAddComment': {
      const issue = target()
      const woken = state.conversation?.source === 'linear' ? state.conversation.placeId : undefined
      if (woken?.toUpperCase() === issue.identifier) {
        throw new RuntimeClientError('linear_waking_issue', WAKING_PLACE_REFUSAL)
      }
      const body = String(params.body ?? '')
      return recordWrite(issue, {
        comment: {
          id: `comment-${Date.now()}`,
          url: `${issueUrl(issue)}#comment`,
          parentId: null
        },
        issue: writeRef(issue),
        meta: {
          ...workspace,
          bodyChars: body.length,
          writeId: 'eval',
          deduplicated: false
        }
      })
    }
    case 'linear.issueSetState': {
      const issue = target()
      const after = set(state, issue, { state: String(params.to ?? '') }, io)
      return recordWrite(
        issue,
        {
          issue: writeRef(issue),
          state: { id: after.state, name: after.state, type: 'started' },
          previousState: { id: issue.state, name: issue.state },
          meta: { ...workspace, alreadyInState: after.state === issue.state }
        },
        after
      )
    }
    case 'linear.issueUpdateTask': {
      const issue = target()
      const labels = Array.isArray(params.labels) ? params.labels.map(String) : []
      const fields =
        params.operation === 'assignee'
          ? {
              assignee:
                params.assigneeMe === true
                  ? OWNER.name
                  : params.assigneeId === null
                    ? null
                    : (WORLD.members.find((member) => member.id === params.assigneeId)?.name ??
                      String(params.assigneeId))
            }
          : params.operation === 'labels'
            ? params.labelMode === 'remove'
              ? { removeLabels: labels }
              : { addLabels: labels }
            : params.operation === 'priority'
              ? {
                  priority: CONNECTOR_PRIORITIES[Number(params.priority ?? 0)] ?? 'none'
                }
              : {}
      set(state, issue, fields, io)
      return recordWrite(issue, {
        issue: writeRef(issue),
        operation: params.operation,
        previous: {},
        current: {},
        meta: { ...workspace, alreadySet: false }
      })
    }
    case 'linear.issueCreate': {
      const team = linearTeam(String(params.teamInput ?? params.teamKey ?? ''))
      if (!team) {
        throw new RuntimeClientError('not_found', 'Linear team not found.')
      }
      const { answer, made } = createLinear(
        team,
        {
          key: `eval:owner:${String(params.writeId ?? params.title)}`,
          title: String(params.title ?? ''),
          ...(params.body ? { text: String(params.body) } : {})
        },
        state.linearRun
      )
      refusedOrThrow(answer)
      if (made) {
        state.linearRun = {
          ...state.linearRun,
          created: [...(state.linearRun?.created ?? []), made]
        }
        io.save(state)
      }
      const issue = made ?? linearIssue(answer.ok ? answer.result.target.ref : '', state.linearRun)!
      return recordWrite(issue, {
        issue: {
          ...writeRef(issue),
          title: issue.title,
          team: { id: team.id, key: team.key, name: team.name },
          state: { id: issue.state, name: issue.state },
          parent: null
        },
        meta: { ...workspace, writeId: 'eval', deduplicated: false }
      })
    }
  }
  if (LINEAR_WRITES.has(method)) {
    io.record({ kind: 'write', method, params })
    throw new RuntimeClientError('unsupported', `${method} is not available on this host.`)
  }
  return undefined
}
