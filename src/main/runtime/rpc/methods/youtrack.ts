import type { Worktree } from '../../../../shared/worktree/types'
import type { CallerWorktreeLookup } from '../../caller-worktree-resolution'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import {
  YouTrackCommentAdd,
  YouTrackFieldSet,
  YouTrackIssueCreate,
  YouTrackIssueList,
  YouTrackIssueRead,
  YouTrackStateSet
} from '../../../../shared/rpc-contract/youtrack-agent-params'
import {
  addYouTrackCommentForAgents,
  createYouTrackIssueForAgents,
  listYouTrackIssuesForAgents,
  readYouTrackIssueForAgents,
  setYouTrackFieldForAgents,
  setYouTrackStateForAgents
} from '../../../youtrack/agent-access'

function callerWorktrees(runtime: OrcaRuntimeService): CallerWorktreeLookup<Worktree> {
  return {
    showTerminal: (handle) => runtime.showTerminal(handle),
    worktreeById: (worktreeId) => runtime.showManagedWorktree(`id:${worktreeId}`),
    worktreeForPath: (cwd) => runtime.resolveWorktreeForContainedPath(cwd)
  }
}

// Why runtime RPC: `orca youtrack` reaches the desktop host that holds the YouTrack token.
export const YOUTRACK_METHODS = [
  defineMethod({
    name: 'youtrack.issue',
    params: YouTrackIssueRead,
    handler: async (params, { runtime }) =>
      readYouTrackIssueForAgents(params, callerWorktrees(runtime))
  }),
  defineMethod({
    name: 'youtrack.list',
    params: YouTrackIssueList,
    handler: async (params) => listYouTrackIssuesForAgents(params)
  }),
  defineMethod({
    name: 'youtrack.commentAdd',
    params: YouTrackCommentAdd,
    handler: async (params, { runtime }) =>
      addYouTrackCommentForAgents(params, callerWorktrees(runtime))
  }),
  defineMethod({
    name: 'youtrack.stateSet',
    params: YouTrackStateSet,
    handler: async (params, { runtime }) =>
      setYouTrackStateForAgents(params, callerWorktrees(runtime))
  }),
  defineMethod({
    name: 'youtrack.fieldSet',
    params: YouTrackFieldSet,
    handler: async (params, { runtime }) =>
      setYouTrackFieldForAgents(params, callerWorktrees(runtime))
  }),
  defineMethod({
    name: 'youtrack.create',
    params: YouTrackIssueCreate,
    handler: async (params) => createYouTrackIssueForAgents(params)
  })
]
