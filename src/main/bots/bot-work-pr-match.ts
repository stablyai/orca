// Which pull request is a bot work row's own.
import type { BotWorkPullRequest } from '../../shared/bots/bot-work-pull-request'
import type { BotWorkWorkspace } from './bot-work-types'

/** The workspace's PR as its row shows it, when it is this work's: open (a branch has one open PR at
 *  a time), or at the worker's head; never an older PR of the branch. */
export function ownPullRequest(workspace: BotWorkWorkspace): BotWorkPullRequest | null {
  const pr = workspace.pullRequest
  return pr && (pr.state === 'open' || pr.state === 'draft' || pr.headSha === workspace.head)
    ? pr
    : null
}
