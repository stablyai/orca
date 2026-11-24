// How the work record asks the runtime for one of this host's worktrees. Kept apart from the record's
// shapes, which the bot evals read without the runtime.
import type { Worktree } from '../../shared/worktree/types'
import type { ScopedWorktreeReads } from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'

/** A worktree of this host by selector; `reads` shares each repo's read across one batch. */
export type BotWorkWorkspaceShow = (
  ...args: [selector: string, requiredHostId?: undefined, reads?: ScopedWorktreeReads]
) => Promise<
  Pick<
    Worktree,
    | 'displayName'
    | 'branch'
    | 'head'
    | 'linkedPR'
    | 'suppressedGitHubPR'
    | 'linkedWorkItem'
    | 'linkedItems'
  >
>
